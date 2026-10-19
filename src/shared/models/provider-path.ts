export type ProviderKind = 'ftp' | 'local' | 'mailru' | 's3' | 'sftp';

export interface MailruProviderPath {
  readonly path: string;
  readonly provider: 'mailru';
}

export interface FtpProviderPath {
  readonly path: string;
  readonly provider: 'ftp';
}

export interface LocalProviderPath {
  readonly path: string;
  readonly provider: 'local';
}

export interface SftpProviderPath {
  readonly path: string;
  readonly provider: 'sftp';
}

export interface S3ProviderPath {
  readonly bucket: string;
  readonly key: string;
  readonly provider: 's3';
}

export type ProviderPath =
  FtpProviderPath | LocalProviderPath | MailruProviderPath | S3ProviderPath | SftpProviderPath;

export const createMailruProviderPath = (path: string): MailruProviderPath => ({
  path,
  provider: 'mailru',
});

export const createRemoteProviderPath = (
  provider: 'ftp' | 'mailru' | 'sftp',
  path: string,
): FtpProviderPath | MailruProviderPath | SftpProviderPath => ({ provider, path });

export const createFtpProviderPath = (path: string): FtpProviderPath => ({
  path,
  provider: 'ftp',
});

export const createLocalProviderPath = (path: string): LocalProviderPath => ({
  path,
  provider: 'local',
});

export const createSftpProviderPath = (path: string): SftpProviderPath => ({
  path,
  provider: 'sftp',
});

export const createS3ProviderPath = (bucket: string, key: string): S3ProviderPath => ({
  bucket,
  key,
  provider: 's3',
});
