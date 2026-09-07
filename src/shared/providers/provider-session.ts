export type ProviderConnectionState =
  'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'failed';

export type SftpConnectionStage =
  | 'authenticating'
  | 'cancelled'
  | 'connected'
  | 'connecting'
  | 'failed'
  | 'handshaking'
  | 'loading-directory'
  | 'opening-sftp'
  | 'resolving-credentials'
  | 'starting'
  | 'verifying-host-key';

export type FtpConnectionStage =
  | 'authenticating'
  | 'cancelled'
  | 'connected'
  | 'connecting'
  | 'failed'
  | 'loading-directory'
  | 'negotiating'
  | 'resolving-credentials'
  | 'starting';

export type ProviderConnectionStage = FtpConnectionStage | SftpConnectionStage;

export interface ProviderSessionSnapshot {
  readonly connectedAt?: string;
  readonly id: string;
  readonly state: ProviderConnectionState;
}
