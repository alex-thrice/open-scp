import { randomUUID } from 'node:crypto';
import { createRcloneLauncher, RcloneProcess, type RcloneLauncher } from './rclone-process';
import type { ICloudConnectionProfile } from '@shared/models/connection-profile';

export interface ICloudAvailability {
  readonly available: boolean;
  readonly remotes: readonly string[];
}

export const discoverICloudAvailability = async (
  launch?: RcloneLauncher,
  executablePath?: string,
): Promise<ICloudAvailability> => {
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
  const signal = AbortSignal.timeout(3000);
  try {
    const version = await runner.output(['version'], 'connect', signal);
    if (!/^rclone v\d+\.\d+/mu.test(version)) return { available: false, remotes: [] };
    const remotes = await runner.icloudRemotes(signal).catch(() => []);
    return { available: true, remotes };
  } catch {
    return { available: false, remotes: [] };
  } finally {
    await runner.close();
  }
};
