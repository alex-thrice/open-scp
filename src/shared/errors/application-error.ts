export const applicationErrorCodes = {
  s3Endpoint: 'S3_ENDPOINT',
  s3Dns: 'S3_DNS',
  s3Tls: 'S3_TLS',
  s3Cleanup: 'S3_CLEANUP',
  s3Integrity: 'S3_INTEGRITY',
  secureStorageUnavailable: 'SECURE_STORAGE_UNAVAILABLE',
  credentialRequired: 'CREDENTIAL_REQUIRED',
  hostKeyUnknown: 'HOST_KEY_UNKNOWN',
  hostKeyChanged: 'HOST_KEY_CHANGED',
  authenticationFailed: 'AUTHENTICATION_FAILED',
  connectionFailed: 'CONNECTION_FAILED',
  externalApplicationFailed: 'EXTERNAL_APPLICATION_FAILED',
  externalApplicationUnavailable: 'EXTERNAL_APPLICATION_UNAVAILABLE',
  unsafeResume: 'UNSAFE_RESUME',
  internalError: 'INTERNAL_ERROR',
  invalidIpcPayload: 'INVALID_IPC_PAYLOAD',
  invalidIpcResponse: 'INVALID_IPC_RESPONSE',
  ipcUnavailable: 'IPC_UNAVAILABLE',
  providerAccessDenied: 'PROVIDER_ACCESS_DENIED',
  providerCancelled: 'PROVIDER_CANCELLED',
  providerConflict: 'PROVIDER_CONFLICT',
  providerInvalidPath: 'PROVIDER_INVALID_PATH',
  providerIoError: 'PROVIDER_IO_ERROR',
  providerNotConnected: 'PROVIDER_NOT_CONNECTED',
  providerNotFound: 'PROVIDER_NOT_FOUND',
  providerUnsupported: 'PROVIDER_UNSUPPORTED',
} as const;

export type ApplicationErrorCode =
  (typeof applicationErrorCodes)[keyof typeof applicationErrorCodes];

export class ApplicationError<Code extends string = string> extends Error {
  public readonly code: Code;
  public readonly messageKey: string;

  public constructor(code: Code, messageKey: string, options?: ErrorOptions) {
    super(messageKey, options);
    this.name = 'ApplicationError';
    this.code = code;
    this.messageKey = messageKey;
  }
}

const safeErrors = {
  [applicationErrorCodes.s3Endpoint]: {
    code: applicationErrorCodes.s3Endpoint,
    messageKey: 'errors.s3.endpoint',
  },
  [applicationErrorCodes.s3Dns]: { code: applicationErrorCodes.s3Dns, messageKey: 'errors.s3.dns' },
  [applicationErrorCodes.s3Tls]: { code: applicationErrorCodes.s3Tls, messageKey: 'errors.s3.tls' },
  [applicationErrorCodes.s3Cleanup]: {
    code: applicationErrorCodes.s3Cleanup,
    messageKey: 'errors.s3.cleanup',
  },
  [applicationErrorCodes.s3Integrity]: {
    code: applicationErrorCodes.s3Integrity,
    messageKey: 'errors.s3.integrity',
  },
  [applicationErrorCodes.secureStorageUnavailable]: {
    code: applicationErrorCodes.secureStorageUnavailable,
    messageKey: 'errors.security.unavailable',
  },
  [applicationErrorCodes.credentialRequired]: {
    code: applicationErrorCodes.credentialRequired,
    messageKey: 'errors.security.credentialRequired',
  },
  [applicationErrorCodes.hostKeyUnknown]: {
    code: applicationErrorCodes.hostKeyUnknown,
    messageKey: 'errors.security.hostKeyUnknown',
  },
  [applicationErrorCodes.hostKeyChanged]: {
    code: applicationErrorCodes.hostKeyChanged,
    messageKey: 'errors.security.hostKeyChanged',
  },
  [applicationErrorCodes.authenticationFailed]: {
    code: applicationErrorCodes.authenticationFailed,
    messageKey: 'errors.security.authenticationFailed',
  },
  [applicationErrorCodes.connectionFailed]: {
    code: applicationErrorCodes.connectionFailed,
    messageKey: 'errors.security.connectionFailed',
  },
  [applicationErrorCodes.externalApplicationFailed]: {
    code: applicationErrorCodes.externalApplicationFailed,
    messageKey: 'errors.external.failed',
  },
  [applicationErrorCodes.externalApplicationUnavailable]: {
    code: applicationErrorCodes.externalApplicationUnavailable,
    messageKey: 'errors.external.unavailable',
  },
  [applicationErrorCodes.unsafeResume]: {
    code: applicationErrorCodes.unsafeResume,
    messageKey: 'errors.transfer.unsafeResume',
  },
  [applicationErrorCodes.internalError]: {
    code: applicationErrorCodes.internalError,
    messageKey: 'errors.unexpected',
  },
  [applicationErrorCodes.invalidIpcPayload]: {
    code: applicationErrorCodes.invalidIpcPayload,
    messageKey: 'errors.ipc.invalidPayload',
  },
  [applicationErrorCodes.invalidIpcResponse]: {
    code: applicationErrorCodes.invalidIpcResponse,
    messageKey: 'errors.ipc.invalidResponse',
  },
  [applicationErrorCodes.ipcUnavailable]: {
    code: applicationErrorCodes.ipcUnavailable,
    messageKey: 'errors.ipc.unavailable',
  },
  [applicationErrorCodes.providerAccessDenied]: {
    code: applicationErrorCodes.providerAccessDenied,
    messageKey: 'errors.provider.accessDenied',
  },
  [applicationErrorCodes.providerCancelled]: {
    code: applicationErrorCodes.providerCancelled,
    messageKey: 'errors.provider.cancelled',
  },
  [applicationErrorCodes.providerConflict]: {
    code: applicationErrorCodes.providerConflict,
    messageKey: 'errors.provider.conflict',
  },
  [applicationErrorCodes.providerInvalidPath]: {
    code: applicationErrorCodes.providerInvalidPath,
    messageKey: 'errors.provider.invalidPath',
  },
  [applicationErrorCodes.providerIoError]: {
    code: applicationErrorCodes.providerIoError,
    messageKey: 'errors.provider.io',
  },
  [applicationErrorCodes.providerNotConnected]: {
    code: applicationErrorCodes.providerNotConnected,
    messageKey: 'errors.provider.notConnected',
  },
  [applicationErrorCodes.providerNotFound]: {
    code: applicationErrorCodes.providerNotFound,
    messageKey: 'errors.provider.notFound',
  },
  [applicationErrorCodes.providerUnsupported]: {
    code: applicationErrorCodes.providerUnsupported,
    messageKey: 'errors.provider.unsupported',
  },
} as const;

export type SerializedApplicationError = (typeof safeErrors)[ApplicationErrorCode];

export const getSafeApplicationError = (code: ApplicationErrorCode): SerializedApplicationError =>
  safeErrors[code];
