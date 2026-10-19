export type ProviderKind = 'ftp' | 'google' | 'local' | 'mailru' | 's3' | 'sftp' | 'yandex';

export interface GoogleProviderPath {
  readonly path: string;
  readonly provider: 'google';
}
export const createGoogleProviderPath = (path: string): GoogleProviderPath => ({
  path,
  provider: 'google',
});

export interface YandexProviderPath {
  readonly path: string;
  readonly provider: 'yandex';
}

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
  | FtpProviderPath
  | GoogleProviderPath
  | LocalProviderPath
  | MailruProviderPath
  | S3ProviderPath
  | SftpProviderPath
  | YandexProviderPath;

export const createYandexProviderPath = (path: string): YandexProviderPath => ({
  path,
  provider: 'yandex',
});

export const createMailruProviderPath = (path: string): MailruProviderPath => ({
  path,
  provider: 'mailru',
});

export const createRemoteProviderPath = (
  provider: 'ftp' | 'google' | 'mailru' | 'sftp' | 'yandex',
  path: string,
):
  | FtpProviderPath
  | GoogleProviderPath
  | MailruProviderPath
  | SftpProviderPath
  | YandexProviderPath => ({
  provider,
  path,
});

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
