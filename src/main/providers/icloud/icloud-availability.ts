import { discoverRcloneAvailability, type RcloneAvailability } from '../rclone/rclone-availability';
import type { RcloneLauncher } from '../rclone/rclone-process';

export type ICloudAvailability = RcloneAvailability;

export const discoverICloudAvailability = (
  launch?: RcloneLauncher,
  executablePath?: string,
): Promise<ICloudAvailability> => discoverRcloneAvailability('icloud', launch, executablePath);
