import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, session, safeStorage, dialog, shell, screen } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { openDatabase } from './persistence/database';
import { CredentialService } from './security/credential-service';
import { ProfileStore } from './persistence/profile-store';
import { WorkspaceService } from './sessions/workspace-service';
import { join } from 'node:path';
import { ipcEventChannels } from '@shared/ipc/channels';
import type { AppReadyEvent, IpcEventEnvelope } from '@shared/ipc/contracts';
import { createIpcHandlerDependencies, registerIpcHandlers } from './ipc/register-ipc-handlers';
import {
  createConfiguredLocalBrowsePaths,
  createDefaultLocalBrowsePaths,
} from './providers/local/local-browse-paths';
import { configureProductionContentSecurityPolicy } from './security/content-security-policy';
import { configureWebContentsSecurity } from './security/web-contents-security';
import { createWindowOptions } from './window-options';
import { setApplicationLanguage } from './application-menu';
import { openSshTerminal } from './external/ssh-terminal';
import { openEditor } from './external/editor';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from './ipc/application-error';
import { fitWindowBounds, readWindowState, type PersistedWindowState } from './window-state';

if (!app.isPackaged) app.setName('OpenSCP');

if (process.env.OPENSCP_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
}

const mainWindows = new Set<BrowserWindow>();

const createAppReadyEvent = (): IpcEventEnvelope<AppReadyEvent> => ({
  correlationId: randomUUID(),
  payload: {
    occurredAt: new Date().toISOString(),
  },
});

const createMainWindow = (profileStore: ProfileStore): BrowserWindow => {
  const persistedState = readWindowState(profileStore.getSetting('main-window-state-v1'));
  const restoredBounds = persistedState
    ? fitWindowBounds(
        persistedState.bounds,
        [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((display) => display.workArea),
        { width: 880, height: 560 },
      )
    : undefined;
  const mainWindow = new BrowserWindow({
    ...createWindowOptions(__dirname),
    ...restoredBounds,
    ...(app.isPackaged ? { icon: join(process.resourcesPath, 'icon.png') } : {}),
  });
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let hasWindowShown = false;
  const saveWindowState = (): void => {
    if (mainWindow.isDestroyed()) return;
    const state: PersistedWindowState = {
      bounds: mainWindow.getNormalBounds(),
      isFullScreen: mainWindow.isFullScreen(),
      isMaximized: mainWindow.isMaximized(),
    };
    profileStore.setSetting('main-window-state-v1', JSON.stringify(state));
  };
  const scheduleWindowStateSave = (): void => {
    if (!hasWindowShown) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 250);
  };
  mainWindow.on('enter-full-screen', scheduleWindowStateSave);
  mainWindow.on('leave-full-screen', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);
  mainWindow.once('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (hasWindowShown) saveWindowState();
  });
  mainWindows.add(mainWindow);

  mainWindow.once('closed', () => {
    mainWindows.delete(mainWindow);
  });

  configureWebContentsSecurity({
    onWillNavigate: (listener) => {
      mainWindow.webContents.on('will-navigate', (event, url) => {
        listener(event, url);
      });
    },
    onWillRedirect: (listener) => {
      mainWindow.webContents.on('will-redirect', (event, url) => {
        listener(event, url);
      });
    },
    setWindowOpenHandler: (handler) => {
      mainWindow.webContents.setWindowOpenHandler((details) => handler(details.url));
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (persistedState?.isFullScreen) mainWindow.setFullScreen(true);
    else if (persistedState?.isMaximized) mainWindow.maximize();
    hasWindowShown = true;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send(ipcEventChannels.appReady, createAppReadyEvent());
  });

  const developmentServerUrl = process.env.ELECTRON_RENDERER_URL;

  if (developmentServerUrl !== undefined) {
    void mainWindow.loadURL(developmentServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
};

app.whenReady().then(async () => {
  const configuredLocalRootPath = process.env.OPENSCP_LOCAL_ROOT;
  const localBrowsePaths =
    app.isPackaged || configuredLocalRootPath === undefined
      ? createDefaultLocalBrowsePaths(app.getPath('home'))
      : createConfiguredLocalBrowsePaths(configuredLocalRootPath);

  await mkdir(app.getPath('userData'), { recursive: true });
  const database = openDatabase(join(app.getPath('userData'), 'settings.sqlite'));
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    getSelectedStorageBackend: () =>
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system',
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
  });
  const dependencies = createIpcHandlerDependencies({
    getDriveIcon: async (path) => {
      const icon = await app.getFileIcon(path, { size: 'small' });
      return icon.isEmpty() ? undefined : icon.toDataURL();
    },
    allowMultipleDrives: app.isPackaged || configuredLocalRootPath === undefined,
    localInitialPath: localBrowsePaths.initialPath,
    localRootPath: localBrowsePaths.rootPath,
  });
  const profileStore = new ProfileStore(database, credentials);
  setApplicationLanguage(profileStore.getSetting('language') === 'ru' ? 'ru' : 'en');
  const workspaceService = new WorkspaceService(
    profileStore,
    credentials,
    async () => dependencies.listLocalDrives(),
    async () => {
      const result = await dialog.showOpenDialog({ properties: ['openFile'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async (kind, content) => {
      const result = await dialog.showSaveDialog({
        defaultPath: `openscp-${kind}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!result.canceled && result.filePath)
        await writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 });
    },
    setApplicationLanguage,
    {
      openEditor,
      openLocalFile: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new ApplicationError(applicationErrorCodes.externalApplicationFailed);
      },
      openSshTerminal,
    },
  );
  app.once('will-quit', () => {
    workspaceService.dispose();
    database.close();
  });
  registerIpcHandlers(
    {
      handle: (channel, handler) => {
        ipcMain.handle(channel, (event, request: unknown) => {
          void event;
          return handler(request);
        });
      },
    },
    { ...dependencies, workspace: (request) => workspaceService.execute(request) },
  );

  if (app.isPackaged) {
    configureProductionContentSecurityPolicy({
      onHeadersReceived: (listener) => {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
          listener(details, callback);
        });
      },
    });
  }

  createMainWindow(profileStore);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(profileStore);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
