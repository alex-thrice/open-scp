import { discoverRcloneAvailability, type RcloneAvailability } from '../rclone/rclone-availability';
import type { RcloneLauncher } from '../rclone/rclone-process';

export type GoogleAvailability = RcloneAvailability;

export const discoverGoogleAvailability = (
  launch?: RcloneLauncher,
  executablePath?: string,
): Promise<GoogleAvailability> => discoverRcloneAvailability('google', launch, executablePath);
