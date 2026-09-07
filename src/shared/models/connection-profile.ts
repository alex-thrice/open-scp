export interface SecretReference {
  readonly id: string;
  readonly storage: 'safe-storage';
}

interface BaseConnectionProfile {
  readonly id: string;
  readonly name: string;
}

export type SftpAuthentication =
  | {
      readonly method: 'agent';
    }
  | {
      readonly method: 'password';
      readonly secret: SecretReference;
    }
  | {
      readonly method: 'private-key';
      readonly passphrase?: SecretReference;
      readonly privateKeyPath: string;
    };

export interface SftpConnectionProfile extends BaseConnectionProfile {
  readonly initialDirectory?: string;
  readonly timeout?: number;
  readonly keepalive?: number;
  readonly authentication: SftpAuthentication;
  readonly host: string;
  readonly kind: 'sftp';
  readonly port: number;
  readonly username: string;
}

export interface FtpConnectionProfile extends BaseConnectionProfile {
  readonly initialDirectory?: string;
  readonly timeout?: number;
  readonly authentication: {
    readonly method: 'password';
    readonly secret: SecretReference;
  };
  readonly host: string;
  readonly kind: 'ftp';
  readonly port: number;
  readonly username: string;
}

export interface S3ConnectionProfile extends BaseConnectionProfile {
  readonly initialPrefix?: string;
  readonly accessKeyId?: string;
  readonly bucket?: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly kind: 's3';
  readonly region: string;
  readonly secret?: SecretReference;
}

export type ConnectionProfile = FtpConnectionProfile | S3ConnectionProfile | SftpConnectionProfile;
