// @vitest-environment node
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverICloudAvailability } from '../../src/main/providers/icloud/icloud-availability';
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
    expect(await discoverICloudAvailability(launch)).toEqual({
      available: true,
      remotes: ['personal', 'work'],
    });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls.map(([args]) => args[0])).toEqual(['version', 'listremotes']);
    expect(fixture.children.size).toBe(0);
  });

  it('distinguishes a missing runtime from one without configured remotes', async () => {
    expect(
      await discoverICloudAvailability((args) =>
        spawn('openscp-rclone-does-not-exist', [...args], { stdio: 'pipe', windowsHide: true }),
      ),
    ).toEqual({ available: false, remotes: [] });
    await fixture.behavior({ remotes: {} });
    expect(await discoverICloudAvailability(fixture.launch)).toEqual({
      available: true,
      remotes: [],
    });
    await fixture.behavior({ remotes: { disk: 'drive' } });
    expect(await discoverICloudAvailability(fixture.launch)).toEqual({
      available: true,
      remotes: [],
    });
    await fixture.behavior({
      command: 'listremotes',
      exit: 1,
      stderr: 'config file is encrypted cookie-canary',
    });
    expect(await discoverICloudAvailability(fixture.launch)).toEqual({
      available: true,
      remotes: [],
    });
    await fixture.behavior({ versionOutput: 'Not a rclone binary\n' });
    expect(await discoverICloudAvailability(fixture.launch)).toEqual({
      available: false,
      remotes: [],
    });
  });

  it('bounds the startup probe and terminates an unresponsive process', async () => {
    await fixture.behavior({ command: 'listremotes', delay: 10000 });
    expect(await discoverICloudAvailability(fixture.launch)).toEqual({
      available: true,
      remotes: [],
    });
    expect(fixture.children.size).toBe(0);
  });
});
