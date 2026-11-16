import { RcloneProvider } from '../rclone/rclone-provider';
import type { ICloudConnection } from './icloud-connection';

export class ICloudProvider extends RcloneProvider<ICloudConnection> {
  public override get kind() {
    return 'icloud' as const;
  }
}
