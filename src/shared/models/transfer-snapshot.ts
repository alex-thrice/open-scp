import type { TransferConflictPolicy, TransferOperationState } from './transfer-operation';

export interface TransferSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly direction: 'upload' | 'download' | 'remote';
  readonly destinationWorkspaceId?: string | undefined;
  readonly reviewReason?: 'restart' | 'uncertain' | undefined;
  readonly errorCategory?: 'transient' | 'auth' | 'conflict' | 'permanent' | undefined;
  readonly state: TransferOperationState;
  readonly conflictPolicy: TransferConflictPolicy;
  readonly transferredBytes: bigint;
  readonly totalBytes: bigint;
  readonly speed: number;
  readonly elapsed: number;
  readonly remaining: number | null;
  readonly errorKey: string | null;
  readonly conflictPath: string | null;
  readonly conflictSourcePath?: string | null | undefined;
}
