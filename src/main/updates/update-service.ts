import type { AppUpdater } from 'electron-updater';
import type { UpdateSettings, UpdateState } from '@shared/models/application-update';

export class UpdateService {
  private state: UpdateState;
  private settings: UpdateSettings;
  private checking: Promise<void> | undefined;
  private downloading: Promise<void> | undefined;

  public constructor(
    private readonly updater: AppUpdater,
    currentVersion: string,
    private readonly supported: boolean,
    settings: UpdateSettings,
  ) {
    this.settings = settings;
    this.state = {
      supported,
      currentVersion,
      availableVersion: null,
      status: 'idle',
      progress: null,
      errorKey: null,
    };
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
    this.updater.on('error', () => {
      this.state = { ...this.state, status: 'error', progress: null, errorKey: 'updates.error' };
    });
  }

  public snapshot(): UpdateState {
    return this.state;
  }

  public async configure(settings: UpdateSettings): Promise<void> {
    this.settings = settings;
    this.updater.autoInstallOnAppQuit = settings.automaticInstall;
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
    this.state = { ...this.state, status: 'checking', progress: null, errorKey: null };
    try {
      await this.updater.checkForUpdates();
      if (this.settings.automaticDownload && this.state.status === 'available') {
        await this.download();
      }
    } catch {
      this.state = { ...this.state, status: 'error', progress: null, errorKey: 'updates.error' };
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
    this.state = { ...this.state, status: 'downloading', progress: 0, errorKey: null };
    try {
      await this.updater.downloadUpdate();
    } catch {
      this.state = { ...this.state, status: 'error', progress: null, errorKey: 'updates.error' };
    }
  }

  public install(): void {
    if (!this.supported || this.state.status !== 'downloaded') return;
    this.updater.quitAndInstall(false, true);
  }
}
