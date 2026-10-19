import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ICloudConnection } from '../../src/main/providers/icloud/icloud-connection';
import { ICloudProvider } from '../../src/main/providers/icloud/icloud-provider';
import type { ICloudConnectionProfile } from '../../src/shared/models/connection-profile';
import type { RcloneLauncher } from '../../src/main/providers/icloud/rclone-process';

export const startICloudFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscp-rclone-'));
  await mkdir(join(root, 'icloud'));
  await mkdir(join(root, 'second'));
  const children = new Set<ChildProcessWithoutNullStreams>();
  const launch: RcloneLauncher = (args, input) => {
    const child = spawn(process.execPath, [resolve('tests/fixtures/rclone-fixture.mjs'), ...args], {
      windowsHide: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        OPENSCP_RCLONE_FIXTURE_ROOT: root,
        ...(input ? { RCLONE_STATE: input.state, RCLONE_RESULT: input.result } : {}),
      },
    });
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  };
  const create = (remote = 'icloud') => {
    const profile: ICloudConnectionProfile = {
      id: randomUUID(),
      name: 'Fixture iCloud',
      kind: 'icloud',
      remote,
      timeout: 1000,
    };
    return new ICloudProvider(new ICloudConnection(profile, launch));
  };
  return {
    root,
    launch,
    create,
    children,
    behavior: (value: object) => writeFile(join(root, 'behavior.json'), JSON.stringify(value)),
    close: async () => {
      for (const child of children) child.kill();
      await Promise.all(
        [...children].map(
          (child) => new Promise<void>((done) => child.once('close', () => done())),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
};
