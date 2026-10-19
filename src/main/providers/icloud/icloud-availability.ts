import { randomUUID } from 'node:crypto';
import { createRcloneLauncher, RcloneProcess, type RcloneLauncher } from './rclone-process';
import type { ICloudConnectionProfile } from '@shared/models/connection-profile';

export const discoverICloudRemotes = async (
  launch?: RcloneLauncher,
  executablePath?: string,
): Promise<readonly string[]> => {
  const profile: ICloudConnectionProfile = {
    id: randomUUID(),
    kind: 'icloud',
    name: 'iCloud availability',
    remote: 'icloud',
    timeout: 3000,
  };
  const runner = new RcloneProcess(
    profile,
    launch ?? createRcloneLauncher(profile, () => executablePath),
  );
  try {
    return await runner.icloudRemotes();
  } catch {
    return [];
  } finally {
    await runner.close();
  }
};
