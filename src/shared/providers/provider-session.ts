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

export interface ProviderSessionSnapshot {
  readonly connectedAt?: string;
  readonly id: string;
  readonly state: ProviderConnectionState;
}
