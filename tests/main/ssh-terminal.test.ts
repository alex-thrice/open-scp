// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { SftpConnectionProfile } from '../../src/shared/models/connection-profile';
import {
  createMacTerminalCommand,
  createOpenSshArguments,
  createPuttyArguments,
  openSshTerminal,
} from '../../src/main/external/ssh-terminal';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

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

const readWindowsLaunchRequest = (arguments_: readonly string[]) => {
  const script = Buffer.from(arguments_.at(-1) ?? '', 'base64').toString('utf16le');
  const encodedRequest = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(script)?.[1];
  expect(encodedRequest).toBeDefined();
  const request = JSON.parse(Buffer.from(encodedRequest ?? '', 'base64').toString('utf8')) as {
    readonly executables: readonly string[];
    readonly arguments: string;
  };
  return { ...request, script };
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
      windowsClient: 'putty',
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
        windowsClient: 'putty',
        startProcess: vi.fn(async () => Promise.reject(missing)),
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_APPLICATION_UNAVAILABLE' });
  });

  it('opens Windows OpenSSH by default in an interactive console without PuTTY', async () => {
    const startProcess = vi.fn<
      (executable: string, arguments_: readonly string[]) => Promise<void>
    >(async () => undefined);
    await openSshTerminal(passwordProfile, 'C:\\Tools\\putty.exe', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      startProcess,
    });
    expect(startProcess).toHaveBeenCalledTimes(1);
    expect(startProcess.mock.calls[0]?.[0]).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    const arguments_ = startProcess.mock.calls[0]?.[1] ?? [];
    expect(arguments_.slice(0, -1)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    const request = readWindowsLaunchRequest(arguments_);
    expect(request.executables).toEqual(['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'ssh.exe']);
    expect(request.arguments).toBe('"-p" "2222" "-l" "test user" "--" "server.example.test"');
    expect(request.script).toContain('$startInfo.UseShellExecute = $true');
    expect(request.script).toContain(
      '$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal',
    );
    expect(request.script).not.toContain('secret-one');
    expect(request.script).not.toContain('putty.exe');
  });

  it('keeps Windows profile data separate from PowerShell syntax and preserves native quoting', async () => {
    const profile: SftpConnectionProfile = {
      ...passwordProfile,
      username: 'user"; & $(whoami)',
      authentication: {
        method: 'private-key',
        privateKeyPath: 'C:\\Мои ключи\\id fixture\\',
        passphrase: { id: 'private-passphrase', storage: 'safe-storage' },
      },
    };
    const directory = '/opt/Проект; $(touch injected)/"quoted"';
    const startProcess = vi.fn<
      (executable: string, arguments_: readonly string[]) => Promise<void>
    >(async () => undefined);
    await openSshTerminal(profile, null, {
      platform: 'win32',
      environment: {},
      directory,
      startProcess,
    });
    const request = readWindowsLaunchRequest(startProcess.mock.calls[0]?.[1] ?? []);
    expect(request.executables).toEqual(['ssh.exe']);
    expect(request.arguments).toContain('"user\\"; & $(whoami)"');
    expect(request.arguments).toContain('"C:\\Мои ключи\\id fixture\\\\"');
    expect(request.arguments).toContain('"-t" "--" "server.example.test"');
    expect(request.arguments).toContain(
      '"cd -- \'/opt/Проект; $(touch injected)/\\"quoted\\"\'; exec \\"${SHELL:-/bin/sh}\\" -l"',
    );
    expect(request.script).not.toContain('whoami');
    expect(request.script).not.toContain('touch injected');
    expect(request.script).not.toContain('private-passphrase');
    expect(request.script).not.toContain('secret-one');
  });

  it('falls back to PowerShell on PATH and safely reports missing or failed Windows launches', async () => {
    const missing = Object.assign(new Error('private path'), { code: 'ENOENT' });
    const startProcess = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce(undefined);
    await openSshTerminal(passwordProfile, null, {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      startProcess,
    });
    expect(startProcess.mock.calls[1]?.[0]).toBe('powershell.exe');

    await expect(
      openSshTerminal(passwordProfile, null, {
        platform: 'win32',
        environment: {},
        startProcess: vi.fn().mockRejectedValue(missing),
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_APPLICATION_UNAVAILABLE' });
    await expect(
      openSshTerminal(passwordProfile, null, {
        platform: 'win32',
        environment: {},
        startProcess: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('private path'), { code: 'EACCES' })),
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_APPLICATION_FAILED' });
  });

  it('waits for the hidden Windows helper to confirm the interactive client was launched', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
    const launched = vi.fn();
    const result = openSshTerminal(passwordProfile, null, {
      platform: 'win32',
      environment: {},
    }).then(launched);
    expect(spawn).toHaveBeenLastCalledWith('powershell.exe', expect.any(Array), {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.emit('spawn');
    await Promise.resolve();
    expect(launched).not.toHaveBeenCalled();
    child.emit('exit', 0);
    await result;
    expect(launched).toHaveBeenCalledOnce();
  });

  it.each([
    [2, 'EXTERNAL_APPLICATION_UNAVAILABLE'],
    [1, 'EXTERNAL_APPLICATION_FAILED'],
    [null, 'EXTERNAL_APPLICATION_FAILED'],
  ])('reports helper exit %s safely as %s', async (exitCode, errorCode) => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
    const result = openSshTerminal(passwordProfile, null, {
      platform: 'win32',
      environment: {},
    });
    const assertion = expect(result).rejects.toMatchObject({ code: errorCode });
    child.emit('exit', exitCode);
    await assertion;
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
        windowsClient: 'putty',
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
          windowsClient: 'putty',
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
