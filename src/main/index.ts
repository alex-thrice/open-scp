import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, session, safeStorage, dialog, shell, screen } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { openDatabase } from './persistence/database';
import { CredentialService } from './security/credential-service';
import { ProfileStore } from './persistence/profile-store';
import { WorkspaceService } from './sessions/workspace-service';
import { join } from 'node:path';
import { ipcEventChannels } from '@shared/ipc/channels';
import type {
  AppReadyEvent,
  ApplicationMenuCommand,
  ApplicationMenuCommandEvent,
  IpcEventEnvelope,
} from '@shared/ipc/contracts';
import { createIpcHandlerDependencies, registerIpcHandlers } from './ipc/register-ipc-handlers';
import {
  createConfiguredLocalBrowsePaths,
  createDefaultLocalBrowsePaths,
} from './providers/local/local-browse-paths';
import { configureProductionContentSecurityPolicy } from './security/content-security-policy';
import { configureWebContentsSecurity } from './security/web-contents-security';
import { createWindowOptions } from './window-options';
import { setApplicationLanguage, type ApplicationMenuActions } from './application-menu';
import { menuResources } from '@shared/localization/menu-resources';
import { openSshTerminal } from './external/ssh-terminal';
import { normalizeMacApplicationPath, openEditor } from './external/editor';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from './ipc/application-error';
import { fitWindowBounds, readWindowState, type PersistedWindowState } from './window-state';
import { loadAutoUpdater, UpdateService } from './updates/update-service';
import {
  defaultUpdateSettings,
  updateSettingsSchema,
  type UpdateSettings,
} from '@shared/models/application-update';

if (!app.isPackaged) app.setName('OpenSCP');

if (process.env.OPENSCP_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
}

const mainWindows = new Set<BrowserWindow>();
const repositoryUrl = 'https://github.com/alex-thrice/open-scp';

interface ApplicationCloseGuard {
  approve(): void;
  hasActiveTransfers(): boolean;
  isApproved(): boolean;
}

const readUpdateSettings = (value: string | undefined): UpdateSettings => {
  try {
    const parsed = updateSettingsSchema.safeParse(JSON.parse(value ?? 'null'));
    return parsed.success ? parsed.data : defaultUpdateSettings;
  } catch {
    return defaultUpdateSettings;
  }
};

const confirmActiveTransfersClose = async (
  window: BrowserWindow | undefined,
  language: 'en' | 'ru',
): Promise<boolean> => {
  const russian = language === 'ru';
  const options = {
    type: 'warning' as const,
    title: russian ? 'Завершение OpenSCP' : 'Quit OpenSCP',
    message: russian ? 'Прервать активные передачи?' : 'Interrupt active transfers?',
    detail: russian
      ? 'В очереди есть активные задачи. При закрытии приложения они будут прерваны.'
      : 'The queue contains active tasks. Closing the application will interrupt them.',
    buttons: russian ? ['Остаться', 'Прервать и выйти'] : ['Keep Open', 'Interrupt and Quit'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
};

const createAppReadyEvent = (): IpcEventEnvelope<AppReadyEvent> => ({
  correlationId: randomUUID(),
  payload: {
    occurredAt: new Date().toISOString(),
  },
});

const createApplicationMenuCommandEvent = (
  command: ApplicationMenuCommand,
): IpcEventEnvelope<ApplicationMenuCommandEvent> => ({
  correlationId: randomUUID(),
  payload: { command },
});

const mainWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ?? [...mainWindows][0];

const openRepository = async (): Promise<void> => {
  await shell.openExternal(repositoryUrl);
};

const showApplicationAbout = async (language: 'en' | 'ru'): Promise<void> => {
  const labels = menuResources[language];
  const window = mainWindow();
  const options = {
    type: 'info' as const,
    title: labels.about,
    message: 'OpenSCP',
    detail: `${labels.version}: ${app.getVersion()}\n${repositoryUrl}`,
    buttons: [labels.openGitHub, labels.close],
    cancelId: 1,
    defaultId: 1,
    noLink: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) await openRepository();
};

const createMainWindow = (
  profileStore: ProfileStore,
  closeGuard: ApplicationCloseGuard,
): BrowserWindow => {
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
  let closePrompting = false;
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
  mainWindow.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (hasWindowShown) saveWindowState();
  });
  mainWindow.on('close', (event) => {
    if (
      process.platform === 'darwin' ||
      closeGuard.isApproved() ||
      !closeGuard.hasActiveTransfers()
    )
      return;
    event.preventDefault();
    if (closePrompting) return;
    closePrompting = true;
    const language = profileStore.getSetting('language') === 'ru' ? 'ru' : 'en';
    void confirmActiveTransfersClose(mainWindow, language).then((confirmed) => {
      closePrompting = false;
      if (!confirmed || mainWindow.isDestroyed()) return;
      closeGuard.approve();
      mainWindow.close();
    });
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
  let applicationCloseApproved = false;
  let readActiveTransfers = (): boolean => false;
  const closeGuard: ApplicationCloseGuard = {
    approve: () => {
      applicationCloseApproved = true;
    },
    hasActiveTransfers: () => readActiveTransfers(),
    isApproved: () => applicationCloseApproved,
  };
  const updateSettings = readUpdateSettings(profileStore.getSetting('update-settings-v1'));
  const updateService = new UpdateService(
    await loadAutoUpdater(app.isPackaged),
    app.getVersion(),
    app.isPackaged,
    updateSettings,
  );
  const applicationMenuActions: ApplicationMenuActions = {
    openAbout: (language) => void showApplicationAbout(language),
    openRepository: () => void openRepository(),
    sendCommand: (command) => {
      const window = mainWindow();
      if (window && !window.isDestroyed())
        window.webContents.send(
          ipcEventChannels.applicationMenuCommand,
          createApplicationMenuCommandEvent(command),
        );
    },
  };
  const applyApplicationLanguage = (language: 'en' | 'ru'): void =>
    setApplicationLanguage(language, applicationMenuActions);
  applyApplicationLanguage(profileStore.getSetting('language') === 'ru' ? 'ru' : 'en');
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
    applyApplicationLanguage,
    {
      checkForUpdates: () => updateService.check(),
      downloadUpdate: () => updateService.download(),
      installUpdate: async () => {
        if (!closeGuard.isApproved() && closeGuard.hasActiveTransfers()) {
          const language = profileStore.getSetting('language') === 'ru' ? 'ru' : 'en';
          const window = BrowserWindow.getFocusedWindow() ?? [...mainWindows][0];
          if (!(await confirmActiveTransfersClose(window, language))) return;
          closeGuard.approve();
        }
        updateService.install();
      },
      openEditor,
      openLocalFile: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new ApplicationError(applicationErrorCodes.externalApplicationFailed);
      },
      openSshTerminal,
      pickEditor: async () => {
        const result = await dialog.showOpenDialog({
          ...(process.platform === 'darwin' ? { defaultPath: '/Applications' } : {}),
          properties: ['openFile'],
        });
        const path = result.canceled ? undefined : result.filePaths[0];
        return path && process.platform === 'darwin'
          ? normalizeMacApplicationPath(path)
          : (path ?? null);
      },
      setUpdateSettings: (settings) => updateService.configure(settings),
      updateState: () => updateService.snapshot(),
    },
  );
  readActiveTransfers = () => workspaceService.transfers.hasAnyActive();
  app.once('will-quit', () => {
    workspaceService.dispose();
    database.close();
  });
  let applicationQuitPrompting = false;
  app.on('before-quit', (event) => {
    if (
      process.platform !== 'darwin' ||
      closeGuard.isApproved() ||
      !closeGuard.hasActiveTransfers()
    )
      return;
    event.preventDefault();
    if (applicationQuitPrompting) return;
    applicationQuitPrompting = true;
    const language = profileStore.getSetting('language') === 'ru' ? 'ru' : 'en';
    const window = BrowserWindow.getFocusedWindow() ?? [...mainWindows][0];
    void confirmActiveTransfersClose(window, language).then((confirmed) => {
      applicationQuitPrompting = false;
      if (!confirmed) return;
      closeGuard.approve();
      app.quit();
    });
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

  createMainWindow(profileStore, closeGuard);
  if (app.isPackaged && updateSettings.automaticCheck) void updateService.check();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(profileStore, closeGuard);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
