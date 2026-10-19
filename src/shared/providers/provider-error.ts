import { ApplicationError } from '@shared/errors/application-error';
import type { ProviderKind } from '@shared/models/provider-path';

export const providerErrorCodes = {
  accessDenied: 'PROVIDER_ACCESS_DENIED',
  cancelled: 'PROVIDER_CANCELLED',
  conflict: 'PROVIDER_CONFLICT',
  invalidPath: 'PROVIDER_INVALID_PATH',
  ioError: 'PROVIDER_IO_ERROR',
  notConnected: 'PROVIDER_NOT_CONNECTED',
  notFound: 'PROVIDER_NOT_FOUND',
  unsupported: 'PROVIDER_UNSUPPORTED',
  quotaExceeded: 'PROVIDER_QUOTA_EXCEEDED',
  rateLimited: 'PROVIDER_RATE_LIMITED',
} as const;

export type ProviderErrorCode = (typeof providerErrorCodes)[keyof typeof providerErrorCodes];

export type ProviderOperation =
  | 'connect'
  | 'create-directory'
  | 'delete'
  | 'disconnect'
  | 'list'
  | 'read'
  | 'rename'
  | 'stat'
  | 'write';

const providerErrorMessageKeys: Record<ProviderErrorCode, string> = {
  [providerErrorCodes.accessDenied]: 'errors.provider.accessDenied',
  [providerErrorCodes.cancelled]: 'errors.provider.cancelled',
  [providerErrorCodes.conflict]: 'errors.provider.conflict',
  [providerErrorCodes.invalidPath]: 'errors.provider.invalidPath',
  [providerErrorCodes.ioError]: 'errors.provider.io',
  [providerErrorCodes.notConnected]: 'errors.provider.notConnected',
  [providerErrorCodes.notFound]: 'errors.provider.notFound',
  [providerErrorCodes.unsupported]: 'errors.provider.unsupported',
  [providerErrorCodes.quotaExceeded]: 'errors.provider.quotaExceeded',
  [providerErrorCodes.rateLimited]: 'errors.provider.rateLimited',
};

export interface ProviderProtocolCause {
  readonly code?: string;
  readonly operation: ProviderOperation;
  readonly provider: ProviderKind;
}

export class ProviderError extends ApplicationError<ProviderErrorCode> {
  public readonly protocolCause: ProviderProtocolCause;

  public constructor(
    code: ProviderErrorCode,
    protocolCause: ProviderProtocolCause,
    options?: ErrorOptions,
  ) {
    super(code, providerErrorMessageKeys[code], options);
    this.name = 'ProviderError';
    this.protocolCause = protocolCause;
  }
}
