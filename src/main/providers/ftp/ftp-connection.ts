import { Client, FTPError } from 'basic-ftp';
import type { FtpConnectionProfile } from '@shared/models/connection-profile';
import type {
  FtpConnectionStage,
  ProviderConnectionState,
} from '@shared/providers/provider-session';
import { applicationErrorCodes, type ApplicationErrorCode } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';

export interface FtpCredentials {
  readonly password: string;
}

const connectionError = (error: unknown): ApplicationError => {
  if (error instanceof ApplicationError) return error;
  const code =
    error instanceof FTPError && (error.code === 530 || error.code === 532)
      ? applicationErrorCodes.authenticationFailed
      : applicationErrorCodes.connectionFailed;
  return new ApplicationError(code, { cause: error });
};

export class FtpConnection {
  public state: ProviderConnectionState = 'disconnected';
  public stage: FtpConnectionStage | undefined;
  public failureCode: ApplicationErrorCode | undefined;
  private clientInstance: Client | undefined;
  private connecting: Promise<void> | undefined;
  private generation = 0;

  public constructor(
    public readonly profile: FtpConnectionProfile,
    private readonly getCredentials: () => Promise<FtpCredentials>,
    private readonly createClient: (timeout: number) => Client = (timeout) =>
      new Client(timeout, {
        allowSeparateTransferHost: false,
        maxListingBytes: 40 * 1024 * 1024,
      }),
  ) {}

  public connect(): Promise<void> {
    if (this.state === 'connected' && !this.clientInstance?.closed) return Promise.resolve();
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async establish(): Promise<void> {
    this.disconnect();
    const generation = this.generation;
    this.state = 'connecting';
    this.stage = 'starting';
    this.failureCode = undefined;
    let client: Client | undefined;
    try {
      this.stage = 'resolving-credentials';
      const credentials = await this.getCredentials();
      if (generation !== this.generation)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      if (
        credentials.password.includes('\0') ||
        credentials.password.includes('\r') ||
        credentials.password.includes('\n')
      )
        throw new ApplicationError(applicationErrorCodes.authenticationFailed);
      client = this.createClient(this.profile.timeout ?? 20000);
      this.clientInstance = client;
      this.stage = 'connecting';
      await client.connect(this.profile.host, this.profile.port);
      if (generation !== this.generation)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      this.stage = 'authenticating';
      await client.login(this.profile.username, credentials.password);
      if (generation !== this.generation)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      this.stage = 'negotiating';
      await client.useDefaultSettings();
      if (generation !== this.generation)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      client.ftp.socket.once('close', () => {
        if (this.clientInstance === client && this.state === 'connected') {
          this.state = 'failed';
          this.stage = 'failed';
          this.failureCode = applicationErrorCodes.connectionFailed;
        }
      });
      this.state = 'connected';
      this.stage = 'connected';
    } catch (error) {
      if (generation !== this.generation)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      const normalized = connectionError(error);
      this.state = 'failed';
      this.stage =
        normalized.code === applicationErrorCodes.providerCancelled ? 'cancelled' : 'failed';
      this.failureCode = normalized.code as ApplicationErrorCode;
      client?.close();
      throw normalized;
    }
  }

  public client(): Client {
    if (
      this.state !== 'connected' ||
      this.clientInstance === undefined ||
      this.clientInstance.closed
    ) {
      if (this.state === 'connected') {
        this.state = 'failed';
        this.stage = 'failed';
        this.failureCode = applicationErrorCodes.connectionFailed;
      }
      throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    }
    return this.clientInstance;
  }

  public setDirectoryLoading(isLoading: boolean): void {
    if (this.state === 'connected') this.stage = isLoading ? 'loading-directory' : 'connected';
  }

  public cancelOperation(): void {
    this.generation += 1;
    const client = this.clientInstance;
    this.clientInstance = undefined;
    this.state = 'disconnected';
    this.stage = 'cancelled';
    this.failureCode = applicationErrorCodes.providerCancelled;
    client?.close();
  }

  public disconnect(): void {
    const wasConnecting = this.state === 'connecting';
    this.generation += 1;
    const client = this.clientInstance;
    this.clientInstance = undefined;
    this.state = 'disconnected';
    this.stage = wasConnecting ? 'cancelled' : undefined;
    this.failureCode = wasConnecting ? applicationErrorCodes.providerCancelled : undefined;
    client?.close();
  }
}
