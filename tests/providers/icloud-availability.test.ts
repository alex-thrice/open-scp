// @vitest-environment node
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverICloudRemotes } from '../../src/main/providers/icloud/icloud-availability';
import { startICloudFixture } from '../fixtures/icloud-harness';

describe('startup iCloud availability', () => {
  let fixture: Awaited<ReturnType<typeof startICloudFixture>>;
  beforeEach(async () => {
    fixture = await startICloudFixture();
  });
  afterEach(async () => {
    await fixture.close();
  });

  it('discovers only usable iCloud remote names without contacting Apple', async () => {
    await fixture.behavior({
      remotes: {
        personal: 'iclouddrive',
        work: 'iclouddrive',
        other: 'sftp',
        invalid: 'iclouddrive-extra',
        'not supported': 'iclouddrive',
      },
    });
    const launch = vi.fn(fixture.launch);
    expect(await discoverICloudRemotes(launch)).toEqual(['personal', 'work']);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0].slice(0, 2)).toEqual(['listremotes', '--long']);
    expect(fixture.children.size).toBe(0);
  });

  it('disables iCloud when rclone is missing, unconfigured or cannot read its config', async () => {
    expect(
      await discoverICloudRemotes((args) =>
        spawn('openscp-rclone-does-not-exist', [...args], { stdio: 'pipe', windowsHide: true }),
      ),
    ).toEqual([]);
    await fixture.behavior({ remotes: {} });
    expect(await discoverICloudRemotes(fixture.launch)).toEqual([]);
    await fixture.behavior({ remotes: { disk: 'drive' } });
    expect(await discoverICloudRemotes(fixture.launch)).toEqual([]);
    await fixture.behavior({ exit: 1, stderr: 'config file is encrypted cookie-canary' });
    expect(await discoverICloudRemotes(fixture.launch)).toEqual([]);
  });

  it('bounds the startup probe and terminates an unresponsive process', async () => {
    await fixture.behavior({ command: 'listremotes', delay: 10000 });
    expect(await discoverICloudRemotes(fixture.launch)).toEqual([]);
    expect(fixture.children.size).toBe(0);
  });
});
