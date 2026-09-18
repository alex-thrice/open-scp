export interface ProviderCapabilities {
  readonly atomicRename: boolean;
  readonly checksum: boolean;
  readonly createDirectory: boolean;
  readonly delete: boolean;
  readonly modificationTime: boolean;
  readonly multipartUpload: boolean;
  readonly permissions: boolean;
  readonly read: boolean;
  readonly rename: boolean;
  readonly resumeRead: boolean;
  readonly resumeWrite: boolean;
  readonly serverSideCopy: boolean;
  readonly symbolicLinks: boolean;
  readonly trueDirectories: boolean;
  readonly write: boolean;
  readonly writeProgress?: boolean;
}
