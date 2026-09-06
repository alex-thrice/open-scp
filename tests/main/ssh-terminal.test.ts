// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { SftpConnectionProfile } from '../../src/shared/models/connection-profile';
import {
  createMacTerminalCommand,
  createOpenSshArguments,
  createPuttyArguments,
  openSshTerminal,
} from '../../src/main/external/ssh-terminal';

const passwordProfile: SftpConnectionProfile = {
  id: 'profile-one',
  kind: 'sftp',
  name: 'Fixture',
  host: 'server.example.test',
  port: 2222,
  username: 'test user',
  authentication: {
    method: 'password',
    secret: { id: 'secret-one', storage: 'safe-storage' },
  },
};

describe('SSH terminal launcher', () => {
  it('builds discrete PuTTY arguments without credentials', () => {
    const arguments_ = createPuttyArguments(passwordProfile);
    expect(arguments_).toEqual(['-ssh', '-P', '2222', '-l', 'test user', 'server.example.test']);
    expect(arguments_.join(' ')).not.toContain('secret-one');
  });

  it('passes a private key to OpenSSH as a separate argument', () => {
    const profile: SftpConnectionProfile = {
      ...passwordProfile,
      authentication: {
        method: 'private-key',
        privateKeyPath: '/home/test user/.ssh/id fixture',
      },
    };
    expect(createOpenSshArguments(profile)).toEqual([
      '-p',
      '2222',
      '-l',
      'test user',
      '-i',
      '/home/test user/.ssh/id fixture',
      '--',
      'server.example.test',
    ]);
  });

  it('quotes every macOS command argument against shell injection', () => {
    const profile: SftpConnectionProfile = {
      ...passwordProfile,
      username: "user'; touch /tmp/injected; '",
    };
    const command = createMacTerminalCommand(profile, "/tmp/file'; false; '.command");
    expect(command).toContain("'user'\"'\"'; touch /tmp/injected; '\"'\"''");
    expect(command).toContain("rm -f -- '/tmp/file'\"'\"'; false; '\"'\"'.command'");
  });

  it('uses a configured PuTTY path and reports a missing executable safely', async () => {
    const startProcess = vi.fn(async () => undefined);
    await openSshTerminal(passwordProfile, 'C:\\Tools\\putty.exe', {
      platform: 'win32',
      startProcess,
    });
    expect(startProcess).toHaveBeenCalledWith(
      'C:\\Tools\\putty.exe',
      createPuttyArguments(passwordProfile),
    );

    const missing = Object.assign(new Error('private path'), { code: 'ENOENT' });
    await expect(
      openSshTerminal(passwordProfile, 'C:\\Missing\\putty.exe', {
        platform: 'win32',
        startProcess: vi.fn(async () => Promise.reject(missing)),
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_APPLICATION_UNAVAILABLE' });
  });

  it('falls back between Linux terminal emulators', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const startProcess = vi
      .fn<(executable: string, arguments_: readonly string[]) => Promise<void>>()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined);
    await openSshTerminal(passwordProfile, null, { platform: 'linux', startProcess });
    expect(startProcess.mock.calls[0]?.[0]).toBe('x-terminal-emulator');
    expect(startProcess.mock.calls[1]?.[0]).toBe('gnome-terminal');
  });
});
