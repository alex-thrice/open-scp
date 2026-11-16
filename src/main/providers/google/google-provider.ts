import { RcloneProvider } from '../rclone/rclone-provider';
import type { GoogleConnection } from './google-connection';

export class GoogleProvider extends RcloneProvider<GoogleConnection> {
  public override get kind() {
    return 'google' as const;
  }
}
