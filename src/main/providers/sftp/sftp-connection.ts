import { createHash } from 'node:crypto';
import { Client, type SFTPWrapper } from 'ssh2';
import type { SftpConnectionProfile } from '@shared/models/connection-profile';
import type {
  ProviderConnectionState,
  SftpConnectionStage,
} from '@shared/providers/provider-session';
import { applicationErrorCodes, type ApplicationErrorCode } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';

export interface SftpCredentials {
  readonly password?: string;
  readonly privateKey?: Buffer;
  readonly passphrase?: string;
  readonly agent?: string;
}
export interface HostKeyStore {
  getHostKey(host: string, port: number): string | undefined;
}

export class SftpConnection {
  public state: ProviderConnectionState = 'disconnected';
  public stage: SftpConnectionStage | undefined;
  public failureCode: ApplicationErrorCode | undefined;
  public hostKey: { fingerprint: string; changed: boolean } | undefined;
  private client: Client | undefined;
  private controlChannel: SFTPWrapper | undefined;
  private dataChannel: SFTPWrapper | undefined;
  private connecting: Promise<void> | undefined;
  private openingData: Promise<SFTPWrapper> | undefined;
  private generation = 0;
  private cancelConnecting: (() => void) | undefined;

  public constructor(
    public readonly profile: SftpConnectionProfile,
    private readonly getCredentials: () => Promise<SftpCredentials>,
    private readonly knownHosts: HostKeyStore,
  ) {}

  public connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
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
    this.hostKey = undefined;
    try {
      this.stage = 'resolving-credentials';
      const credentials = await this.getCredentials();
      if (generation !== this.generation)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      const client = new Client();
      this.client = client;
      this.stage = 'connecting';
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        this.cancelConnecting = () => {
          if (!settled) {
            settled = true;
            reject(new ApplicationError(applicationErrorCodes.providerCancelled));
          }
        };
        const fail = (error?: Error & { level?: string }): void => {
          if (this.client !== client) return;
          if (settled && this.state !== 'connected') return;
          const code =
            this.hostKey !== undefined
              ? this.hostKey.changed
                ? applicationErrorCodes.hostKeyChanged
                : applicationErrorCodes.hostKeyUnknown
              : error?.level === 'client-authentication'
                ? applicationErrorCodes.authenticationFailed
                : applicationErrorCodes.connectionFailed;
          this.state = 'failed';
          this.failureCode = code;
          this.stage = 'failed';
          if (settled) return;
          settled = true;
          reject(new ApplicationError(code));
          client.destroy();
        };
        client.on('error', fail);
        client.on('close', () => fail());
        client.once('ready', () => {
          this.stage = 'opening-sftp';
          client.sftp((error, channel) => {
            if (error) {
              fail(error);
              return;
            }
            if (settled || this.client !== client) {
              channel.end();
              return;
            }
            settled = true;
            this.controlChannel = channel;
            channel.on('error', () => {
              if (this.controlChannel === channel) {
                this.state = 'failed';
                this.stage = 'failed';
                this.failureCode = applicationErrorCodes.connectionFailed;
              }
            });
            channel.once('close', () => {
              if (this.controlChannel === channel) {
                this.state = 'failed';
                this.stage = 'failed';
                this.failureCode = applicationErrorCodes.connectionFailed;
              }
            });
            this.state = 'connected';
            this.stage = 'connected';
            this.failureCode = undefined;
            resolve();
          });
        });
        client.connect({
          host: this.profile.host,
          port: this.profile.port,
          username: this.profile.username,
          readyTimeout: this.profile.timeout ?? 20000,
          keepaliveInterval: this.profile.keepalive ?? 10000,
          keepaliveCountMax: 3,
          ...credentials,
          hostVerifier: (key: Buffer): boolean => {
            this.stage = 'verifying-host-key';
            const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
            const trusted = this.knownHosts.getHostKey(this.profile.host, this.profile.port);
            if (trusted === fingerprint) {
              this.stage = 'authenticating';
              return true;
            }
            this.hostKey = { fingerprint, changed: trusted !== undefined };
            return false;
          },
        });
        if (this.client === client && this.stage === 'connecting') this.stage = 'handshaking';
      });
    } catch (error) {
      if (generation === this.generation) {
        this.state = 'failed';
        if (error instanceof ApplicationError) this.failureCode = error.code;
        else this.failureCode = applicationErrorCodes.connectionFailed;
        this.stage =
          this.failureCode === applicationErrorCodes.providerCancelled ? 'cancelled' : 'failed';
      }
      throw error;
    } finally {
      if (generation === this.generation) this.cancelConnecting = undefined;
    }
  }

  public control(): SFTPWrapper {
    if (this.state !== 'connected' || this.controlChannel === undefined)
      throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    return this.controlChannel;
  }

  public async data(): Promise<SFTPWrapper> {
    this.control();
    if (this.dataChannel !== undefined) return this.dataChannel;
    const client = this.client;
    if (!client) throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    this.openingData ??= new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, channel) => {
        if (error) {
          reject(new ApplicationError(applicationErrorCodes.connectionFailed));
          return;
        }
        if (this.client !== client || this.state !== 'connected') {
          channel.end();
          reject(new ApplicationError(applicationErrorCodes.providerNotConnected));
          return;
        }
        this.dataChannel = channel;
        channel.on('error', () => {
          if (this.dataChannel === channel) {
            this.state = 'failed';
            this.stage = 'failed';
            this.failureCode = applicationErrorCodes.connectionFailed;
          }
        });
        channel.once('close', () => {
          if (this.dataChannel === channel) {
            this.state = 'failed';
            this.stage = 'failed';
            this.failureCode = applicationErrorCodes.connectionFailed;
          }
        });
        resolve(channel);
      });
    }).finally(() => {
      if (this.client === client) this.openingData = undefined;
    });
    return this.openingData;
  }

  public setDirectoryLoading(isLoading: boolean): void {
    if (this.state === 'connected') this.stage = isLoading ? 'loading-directory' : 'connected';
  }

  public disconnect(): void {
    const wasConnecting = this.state === 'connecting';
    this.generation += 1;
    this.cancelConnecting?.();
    this.cancelConnecting = undefined;
    const client = this.client;
    this.client = undefined;
    this.controlChannel = undefined;
    this.dataChannel = undefined;
    this.openingData = undefined;
    this.state = 'disconnected';
    this.stage = wasConnecting ? 'cancelled' : undefined;
    this.failureCode = wasConnecting ? applicationErrorCodes.providerCancelled : undefined;
    client?.destroy();
  }
}
