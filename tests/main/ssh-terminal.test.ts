// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('quotes the remote directory and requests an interactive terminal in OpenSSH', () => {
    const directory = "/opt/Проект с пробелами/it's $(touch injected); `id`\nnext";
    const arguments_ = createOpenSshArguments(passwordProfile, directory);
    expect(arguments_).toEqual([
      '-p',
      '2222',
      '-l',
      'test user',
      '-t',
      '--',
      'server.example.test',
      "cd -- '/opt/Проект с пробелами/it'\"'\"'s $(touch injected); `id`\nnext'; exec \"${SHELL:-/bin/sh}\" -l",
    ]);
  });

  it('keeps the quoted remote command intact inside the macOS launcher script', () => {
    const command = createMacTerminalCommand(
      passwordProfile,
      '/tmp/terminal.command',
      '/opt/my app',
    );
    expect(command).toContain("'-t' '--' 'server.example.test'");
    expect(command).toContain("'cd -- '\"'\"'/opt/my app'\"'\"'; exec \"${SHELL:-/bin/sh}\" -l'");
  });

  it('passes a UTF-8 command file to PuTTY and removes it when the terminal closes', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'openscp-putty-command-'));
    try {
      const startProcess = vi.fn<
        (executable: string, arguments_: readonly string[], onExit?: () => void) => Promise<void>
      >(async () => undefined);
      await openSshTerminal(passwordProfile, 'C:\\Tools\\putty.exe', {
        directory: "/opt/Мой проект/it's here",
        platform: 'win32',
        startProcess,
        temporaryDirectory,
      });
      const arguments_ = startProcess.mock.calls[0]?.[1] ?? [];
      const commandPath = arguments_[arguments_.indexOf('-m') + 1] ?? '';
      expect(arguments_).toEqual([
        ...createPuttyArguments(passwordProfile),
        '-m',
        commandPath,
        '-t',
      ]);
      expect(await readFile(commandPath, 'utf8')).toBe(
        "cd -- '/opt/Мой проект/it'\"'\"'s here'; exec \"${SHELL:-/bin/sh}\" -l",
      );
      const onExit = startProcess.mock.calls[0]?.[2];
      expect(onExit).toBeTypeOf('function');
      onExit?.();
      await vi.waitFor(async () => expect(await readdir(temporaryDirectory)).toEqual([]));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('removes the remote command file if PuTTY cannot start', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'openscp-putty-missing-'));
    try {
      await expect(
        openSshTerminal(passwordProfile, 'C:\\Missing\\putty.exe', {
          directory: '/opt/app',
          platform: 'win32',
          startProcess: vi.fn(async () => {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }),
          temporaryDirectory,
        }),
      ).rejects.toMatchObject({ code: 'EXTERNAL_APPLICATION_UNAVAILABLE' });
      expect(await readdir(temporaryDirectory)).toEqual([]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('falls back between Linux terminal emulators', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const startProcess = vi
      .fn<(executable: string, arguments_: readonly string[]) => Promise<void>>()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined);
    await openSshTerminal(passwordProfile, null, {
      directory: '/opt/current directory',
      platform: 'linux',
      startProcess,
    });
    expect(startProcess.mock.calls[0]?.[0]).toBe('x-terminal-emulator');
    expect(startProcess.mock.calls[1]?.[0]).toBe('gnome-terminal');
    expect(startProcess.mock.calls[1]?.[1]).toEqual([
      '--',
      'ssh',
      ...createOpenSshArguments(passwordProfile, '/opt/current directory'),
    ]);
  });
});
