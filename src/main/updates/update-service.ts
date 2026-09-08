import type { AppUpdater } from 'electron-updater';
import type { UpdateSettings, UpdateState } from '@shared/models/application-update';

const errorKey = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
    ? 'updates.metadataUnavailable'
    : 'updates.error';

const isAppUpdater = (value: unknown): value is AppUpdater =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'on') === 'function' &&
  typeof Reflect.get(value, 'checkForUpdates') === 'function' &&
  typeof Reflect.get(value, 'downloadUpdate') === 'function' &&
  typeof Reflect.get(value, 'quitAndInstall') === 'function';

export const resolveAutoUpdater = (module: unknown): AppUpdater | undefined => {
  if (typeof module !== 'object' || module === null) return undefined;
  const direct = Reflect.get(module, 'autoUpdater');
  if (isAppUpdater(direct)) return direct;
  const fallback = Reflect.get(module, 'default');
  if (typeof fallback !== 'object' || fallback === null) return undefined;
  const nested = Reflect.get(fallback, 'autoUpdater');
  return isAppUpdater(nested) ? nested : undefined;
};

export const loadAutoUpdater = async (supported: boolean): Promise<AppUpdater | undefined> => {
  if (!supported) return undefined;
  try {
    return resolveAutoUpdater(await import('electron-updater'));
  } catch {
    return undefined;
  }
};

export class UpdateService {
  private state: UpdateState;
  private settings: UpdateSettings;
  private checking: Promise<void> | undefined;
  private downloading: Promise<void> | undefined;
  private readonly supported: boolean;

  public constructor(
    private readonly updater: AppUpdater | undefined,
    currentVersion: string,
    supported: boolean,
    settings: UpdateSettings,
  ) {
    this.settings = settings;
    this.supported = supported && this.updater !== undefined;
    this.state = {
      supported: this.supported,
      currentVersion,
      availableVersion: null,
      status: 'idle',
      progress: null,
      errorKey: null,
    };
    if (!this.updater) return;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = settings.automaticInstall;
    this.updater.on('checking-for-update', () => {
      this.state = { ...this.state, status: 'checking', progress: null, errorKey: null };
    });
    this.updater.on('update-available', (info) => {
      this.state = {
        ...this.state,
        availableVersion: info.version,
        status: 'available',
        progress: null,
        errorKey: null,
      };
    });
    this.updater.on('update-not-available', () => {
      this.state = {
        ...this.state,
        availableVersion: null,
        status: 'not-available',
        progress: null,
        errorKey: null,
      };
    });
    this.updater.on('download-progress', (info) => {
      this.state = {
        ...this.state,
        status: 'downloading',
        progress: Math.max(0, Math.min(100, info.percent)),
        errorKey: null,
      };
    });
    this.updater.on('update-downloaded', (info) => {
      this.state = {
        ...this.state,
        availableVersion: info.version,
        status: 'downloaded',
        progress: 100,
        errorKey: null,
      };
    });
    this.updater.on('error', (error) => {
      this.state = { ...this.state, status: 'error', progress: null, errorKey: errorKey(error) };
    });
  }

  public snapshot(): UpdateState {
    return this.state;
  }

  public async configure(settings: UpdateSettings): Promise<void> {
    this.settings = settings;
    if (this.updater) this.updater.autoInstallOnAppQuit = settings.automaticInstall;
    if (settings.automaticDownload && this.state.status === 'available') await this.download();
  }

  public check(): Promise<void> {
    if (!this.supported) {
      this.state = {
        ...this.state,
        status: 'error',
        errorKey: 'updates.unsupported',
      };
      return Promise.resolve();
    }
    this.checking ??= this.performCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async performCheck(): Promise<void> {
    const updater = this.updater;
    if (!updater) return;
    this.state = { ...this.state, status: 'checking', progress: null, errorKey: null };
    try {
      await updater.checkForUpdates();
      if (this.settings.automaticDownload && this.state.status === 'available') {
        await this.download();
      }
    } catch (error) {
      this.state = { ...this.state, status: 'error', progress: null, errorKey: errorKey(error) };
    }
  }

  public download(): Promise<void> {
    if (!this.supported || this.state.status !== 'available') return Promise.resolve();
    this.downloading ??= this.performDownload().finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }

  private async performDownload(): Promise<void> {
    const updater = this.updater;
    if (!updater) return;
    this.state = { ...this.state, status: 'downloading', progress: 0, errorKey: null };
    try {
      await updater.downloadUpdate();
    } catch (error) {
      this.state = { ...this.state, status: 'error', progress: null, errorKey: errorKey(error) };
    }
  }

  public install(): void {
    if (!this.supported || !this.updater || this.state.status !== 'downloaded') return;
    this.updater.quitAndInstall(false, true);
  }
}
