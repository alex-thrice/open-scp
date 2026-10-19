import type { ProviderPath } from '@shared/models/provider-path';
import type { GoogleEntry } from './google-entry';

export type FileSystemEntryKind = 'directory' | 'file' | 'special' | 'symbolic-link';

export interface FileSystemEntry {
  readonly google?: GoogleEntry;
  readonly kind: FileSystemEntryKind;
  readonly s3Kind?: 'bucket' | 'prefix' | 'object';
  readonly versionTag?: string;
  readonly modifiedAt?: string;
  readonly name: string;
  readonly path: ProviderPath;
  readonly permissions?: number;
  readonly size: bigint;
}
