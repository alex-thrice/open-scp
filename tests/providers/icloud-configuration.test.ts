// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ICloudConfiguration } from '../../src/main/providers/icloud/icloud-configuration';
import { startICloudFixture } from '../fixtures/icloud-harness';

describe('iCloud configuration wizard', () => {
  let fixture: Awaited<ReturnType<typeof startICloudFixture>>;
  let configuration: ICloudConfiguration;
  const appleId = 'gui-canary@example.invalid';
  const password = 'password-canary-$(do-not-run)';
  beforeEach(async () => {
    fixture = await startICloudFixture();
    configuration = new ICloudConfiguration(() => fixture.launch);
  });
  afterEach(async () => {
    configuration.dispose();
    await fixture.close();
  });

  it('handles a wrong code, SMS selection and success without exposing credentials or opaque state', async () => {
    const launch = vi.fn(fixture.launch);
    configuration = new ICloudConfiguration(() => launch);
    const id = randomUUID();
    expect(await configuration.start(id, 'new_account', appleId, password)).toEqual({
      id,
      status: 'question',
      kind: 'verification-code',
      choices: [],
      retry: false,
    });
    expect(configuration.active).toBe(true);
    const rejected = await configuration.continue(id, '000000');
    expect(rejected).toMatchObject({ retry: true, kind: 'verification-code' });
    expect(JSON.stringify(rejected)).not.toContain('secret-error-canary');
    await fixture.behavior({
      command: 'config',
      exit: 1,
      stderr: 'validate2FACode failed: HTTP error 409 secret-error-canary',
    });
    await expect(configuration.continue(id, '000000')).rejects.toMatchObject({
      code: 'RCLONE_AUTHENTICATION',
    });
    await fixture.behavior({});
    expect(await configuration.continue(id, 'sms')).toMatchObject({
      kind: 'phone',
      choices: [
        { value: '1_sms', label: '+1 ••••12' },
        { value: '2_sms', label: '+1 ••••34' },
      ],
    });
    await expect(configuration.continue(id, '--config')).rejects.toMatchObject({
      code: 'INVALID_IPC_PAYLOAD',
    });
    expect(await configuration.continue(id, '2_sms')).toMatchObject({ kind: 'sms-code' });
    expect(await configuration.continue(id, '123456')).toEqual({ id, status: 'complete' });
    expect(configuration.active).toBe(false);
    const argumentsOnly = JSON.stringify(launch.mock.calls.map(([args]) => args));
    expect(argumentsOnly).not.toContain(password);
    expect(argumentsOnly).not.toContain(appleId);
    expect(argumentsOnly).not.toContain('123456');
    expect(launch.mock.calls.some(([args]) => args[0] === 'obscure' && args[1] === '-')).toBe(true);
    expect(launch.mock.calls.some(([, input]) => input?.result === password)).toBe(false);
    await configuration.cancel(id);
    expect(
      JSON.parse(await readFile(join(fixture.root, 'gui-config.json'), 'utf8')),
    ).toHaveProperty('new_account');
  });

  it('rejects existing names and removes only an unfinished connection on cancellation', async () => {
    await expect(
      configuration.start(randomUUID(), 'ICLOUD', appleId, password),
    ).rejects.toMatchObject({ code: 'RCLONE_REMOTE_EXISTS' });
    expect(configuration.active).toBe(false);
    const id = randomUUID();
    await configuration.start(id, 'cancel_me', appleId, password);
    await expect(
      configuration.start(randomUUID(), 'another', appleId, password),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    await configuration.cancel(randomUUID());
    expect(configuration.active).toBe(true);
    await configuration.cancel(id);
    expect(configuration.active).toBe(false);
    expect(
      JSON.parse(await readFile(join(fixture.root, 'gui-config.json'), 'utf8')),
    ).not.toHaveProperty('cancel_me');
    await expect(configuration.continue(id, '123456')).rejects.toMatchObject({
      code: 'RCLONE_SETUP_EXPIRED',
    });
  });

  it('can cancel a running authentication process and clean up its partial configuration', async () => {
    await fixture.behavior({ setupDelay: 10000 });
    const id = randomUUID();
    const pending = configuration.start(id, 'pending', appleId, password);
    await vi.waitFor(async () => {
      expect(await readFile(join(fixture.root, 'gui-config.json'), 'utf8')).toContain('pending');
      expect(fixture.children.size).toBeGreaterThan(0);
    });
    await configuration.cancel(id);
    expect(await pending).toEqual({ id, status: 'cancelled' });
    expect(fixture.children.size).toBe(0);
    expect(
      JSON.parse(await readFile(join(fixture.root, 'gui-config.json'), 'utf8')),
    ).not.toHaveProperty('pending');
  });
});
