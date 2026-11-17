import type { GoogleConnectionProfile } from '@shared/models/connection-profile';
import { RcloneConnection } from '../rclone/rclone-connection';

export class GoogleConnection extends RcloneConnection<GoogleConnectionProfile> {}
