import { rcloneFailure } from '../rclone/rclone-process';
import type { ProviderOperation, providerErrorCodes } from '@shared/providers/provider-error';

export { createRcloneLauncher, RcloneProcess } from '../rclone/rclone-process';
export type {
  RcloneCommand,
  RcloneConfigurationInput,
  RcloneLauncher,
} from '../rclone/rclone-process';

export const icloudFailure = (
  code: keyof typeof providerErrorCodes,
  operation: ProviderOperation,
) => rcloneFailure('icloud', code, operation);
