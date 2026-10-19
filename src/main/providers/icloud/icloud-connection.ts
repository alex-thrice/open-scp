import type { ICloudConnectionProfile } from '@shared/models/connection-profile';
import type { ProviderOperationOptions } from '@shared/providers/file-system-provider';
import type { ProviderOperation } from '@shared/providers/provider-error';
import type {
  ProviderConnectionStage,
  ProviderConnectionState,
} from '@shared/providers/provider-session';
import { applicationErrorCodes, type ApplicationErrorCode } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import { icloudFailure, RcloneProcess, type RcloneLauncher } from './rclone-process';

export class ICloudConnection {
  public state: ProviderConnectionState = 'disconnected';
  public stage: ProviderConnectionStage | undefined;
  public failureCode: ApplicationErrorCode | undefined;
  public readonly process: RcloneProcess;
  private connecting: Promise<void> | undefined;
  private lifecycle = new AbortController();

  public constructor(
    public readonly profile: ICloudConnectionProfile,
    launch?: RcloneLauncher,
  ) {
    this.process = new RcloneProcess(profile, launch);
  }

  public connect(options?: ProviderOperationOptions): Promise<void> {
    if (options?.signal?.aborted) return Promise.reject(icloudFailure('cancelled', 'connect'));
    if (this.state === 'connected') return Promise.resolve();
    if (!this.connecting) {
      const pending = this.establish(options).finally(() => {
        if (this.connecting === pending) this.connecting = undefined;
      });
      this.connecting = pending;
    }
    return this.connecting;
  }

  private async establish(options?: ProviderOperationOptions): Promise<void> {
    const lifecycle = this.lifecycle;
    const signal = options?.signal
      ? AbortSignal.any([lifecycle.signal, options.signal])
      : lifecycle.signal;
    this.state = 'connecting';
    this.stage = 'starting';
    this.failureCode = undefined;
    try {
      const remotes = await this.process.icloudRemotes(signal);
      if (!remotes.includes(this.profile.remote))
        throw new ApplicationError(applicationErrorCodes.rcloneConfiguration);
      this.stage = 'authenticating';
      const root = await this.process.json(
        ['lsjson', '--stat', '--no-mimetype', `${this.profile.remote}:`],
        'connect',
        signal,
      );
      if (typeof root !== 'object' || root === null || !('IsDir' in root) || root.IsDir !== true)
        throw new ApplicationError(applicationErrorCodes.rcloneConfiguration);
      if (signal.aborted) throw icloudFailure('cancelled', 'connect');
      this.state = 'connected';
      this.stage = 'connected';
    } catch (error) {
      if (this.lifecycle !== lifecycle) throw icloudFailure('cancelled', 'connect');
      if (signal.aborted) {
        this.state = 'disconnected';
        this.stage = 'cancelled';
        this.failureCode = applicationErrorCodes.providerCancelled;
        throw icloudFailure('cancelled', 'connect');
      }
      this.state = 'failed';
      this.stage = 'failed';
      this.failureCode =
        error instanceof ApplicationError ? error.code : applicationErrorCodes.connectionFailed;
      throw error;
    }
  }

  public signal(operation: ProviderOperation, options?: ProviderOperationOptions): AbortSignal {
    if (this.state !== 'connected') throw icloudFailure('notConnected', operation);
    return options?.signal
      ? AbortSignal.any([this.lifecycle.signal, options.signal])
      : this.lifecycle.signal;
  }

  public failed(error: unknown): void {
    if (
      error instanceof ApplicationError &&
      error.code === applicationErrorCodes.rcloneAuthentication
    ) {
      this.state = 'failed';
      this.stage = 'failed';
      this.failureCode = error.code;
    }
  }

  public setDirectoryLoading(loading: boolean): void {
    if (this.state === 'connected') this.stage = loading ? 'loading-directory' : 'connected';
  }

  public async disconnect(): Promise<void> {
    const wasConnecting = this.state === 'connecting';
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.connecting = undefined;
    this.state = 'disconnected';
    this.stage = wasConnecting ? 'cancelled' : undefined;
    this.failureCode = undefined;
    await this.process.close();
  }
}
