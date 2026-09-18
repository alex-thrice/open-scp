import type { FileSystemEntry } from '@shared/models/file-system-entry';
import type { ProviderKind, ProviderPath } from '@shared/models/provider-path';
import type { ProviderCapabilities } from '@shared/providers/provider-capabilities';
import type { ProviderConnectionState } from '@shared/providers/provider-session';

export interface ProviderOperationOptions {
  readonly offset?: number;
  readonly versionTag?: string;
  readonly signal?: AbortSignal;
}

export interface DeleteOptions extends ProviderOperationOptions {
  readonly recursive: boolean;
}

export interface WriteOptions extends ProviderOperationOptions {
  readonly overwrite: boolean;
  readonly expectedSize?: bigint;
  readonly onProgress?: (bytes: number) => void;
}

export interface RenameOptions extends ProviderOperationOptions {
  readonly overwrite?: boolean;
}

export interface FileSystemProvider {
  readonly capabilities: ProviderCapabilities;
  readonly connectionState: ProviderConnectionState;
  readonly kind: ProviderKind;

  connect(options?: ProviderOperationOptions): Promise<void>;
  disconnect(): Promise<void>;
  list(path: ProviderPath, options?: ProviderOperationOptions): Promise<readonly FileSystemEntry[]>;
  stat(path: ProviderPath, options?: ProviderOperationOptions): Promise<FileSystemEntry>;
  createDirectory(path: ProviderPath, options?: ProviderOperationOptions): Promise<void>;
  delete(path: ProviderPath, options: DeleteOptions): Promise<void>;
  rename(source: ProviderPath, destination: ProviderPath, options?: RenameOptions): Promise<void>;
  openRead(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  openWrite(path: ProviderPath, options: WriteOptions): Promise<WritableStream<Uint8Array>>;
}
