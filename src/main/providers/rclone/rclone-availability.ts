import { randomUUID } from 'node:crypto';
import { createRcloneLauncher, RcloneProcess, type RcloneLauncher } from './rclone-process';
import type { RcloneConnectionProfile } from './rclone-process';

export interface RcloneAvailability {
  readonly available: boolean;
  readonly remotes: readonly string[];
}

export const discoverRcloneAvailability = async (
  kind: RcloneConnectionProfile['kind'],
  launch?: RcloneLauncher,
  executablePath?: string,
): Promise<RcloneAvailability> => {
  const profile: RcloneConnectionProfile = {
    id: randomUUID(),
    kind,
    name: `${kind} availability`,
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
    const remotes = await runner
      .remotes(kind === 'google' ? 'drive' : 'iclouddrive', signal)
      .catch(() => []);
    return { available: true, remotes };
  } catch {
    return { available: false, remotes: [] };
  } finally {
    await runner.close();
  }
};
