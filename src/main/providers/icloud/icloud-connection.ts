import type { ICloudConnectionProfile } from '@shared/models/connection-profile';
import { RcloneConnection } from '../rclone/rclone-connection';

export class ICloudConnection extends RcloneConnection<ICloudConnectionProfile> {}
