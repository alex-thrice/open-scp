import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import type { SftpConnectionProfile } from '@shared/models/connection-profile';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';

type StartProcess = (
  executable: string,
  arguments_: readonly string[],
  onExit?: () => void,
) => Promise<void>;

export interface SshTerminalOptions {
  readonly directory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly startProcess?: StartProcess;
  readonly temporaryDirectory?: string;
  readonly windowsClient?: 'openssh' | 'putty';
}

const startDetachedProcess: StartProcess = (executable, arguments_, onExit) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    if (onExit) child.once('exit', onExit);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

const startWindowsOpenSshProcess: StartProcess = (executable, arguments_) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(), { code: code === 2 ? 'ENOENT' : 'EIO' }));
    });
  });

const isMissingExecutableError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const createRemoteShellCommand = (directory: string): string =>
  `cd -- ${quoteShellArgument(directory)}; exec "\${SHELL:-/bin/sh}" -l`;

export const createOpenSshArguments = (
  profile: SftpConnectionProfile,
  directory?: string,
): readonly string[] => [
  '-p',
  String(profile.port),
  '-l',
  profile.username,
  ...(profile.authentication.method === 'private-key'
    ? ['-i', profile.authentication.privateKeyPath]
    : []),
  ...(directory ? ['-t'] : []),
  '--',
  profile.host,
  ...(directory ? [createRemoteShellCommand(directory)] : []),
];

const quoteWindowsArgument = (value: string): string =>
  `"${value
    .replace(/(\\*)"/gu, (_match, backslashes: string) => `${backslashes}${backslashes}\\"`)
    .replace(/\\+$/u, (backslashes) => `${backslashes}${backslashes}`)}"`;

const createWindowsOpenSshCommand = (
  profile: SftpConnectionProfile,
  environment: NodeJS.ProcessEnv,
  directory: string | undefined,
): readonly string[] => {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  const request = Buffer.from(
    JSON.stringify({
      executables: [
        ...(systemRoot ? [win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe')] : []),
        'ssh.exe',
      ],
      arguments: createOpenSshArguments(profile, directory).map(quoteWindowsArgument).join(' '),
    }),
    'utf8',
  ).toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json
foreach ($executable in $request.executables) {
  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $executable
    $startInfo.Arguments = $request.arguments
    $startInfo.UseShellExecute = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
    $process = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { exit 1 }
    exit 0
  } catch {
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    if (($exception -is [ComponentModel.Win32Exception]) -and ($exception.NativeErrorCode -in 2, 3)) {
      continue
    }
    exit 1
  }
}
exit 2
`;
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
};

export const createPuttyArguments = (
  profile: SftpConnectionProfile,
  commandPath?: string,
): readonly string[] => [
  '-ssh',
  '-P',
  String(profile.port),
  '-l',
  profile.username,
  ...(profile.authentication.method === 'private-key'
    ? ['-i', profile.authentication.privateKeyPath]
    : []),
  profile.host,
  ...(commandPath ? ['-m', commandPath, '-t'] : []),
];

export const createMacTerminalCommand = (
  profile: SftpConnectionProfile,
  scriptPath: string,
  directory?: string,
): string =>
  `#!/bin/sh\nrm -f -- ${quoteShellArgument(scriptPath)}\nexec /usr/bin/ssh ${createOpenSshArguments(profile, directory).map(quoteShellArgument).join(' ')}\n`;

const windowsCandidates = (
  configuredPath: string | null,
  environment: NodeJS.ProcessEnv,
): readonly string[] => {
  if (configuredPath) return [configuredPath];
  const paths = [
    environment.ProgramFiles ? join(environment.ProgramFiles, 'PuTTY', 'putty.exe') : undefined,
    environment['ProgramFiles(x86)']
      ? join(environment['ProgramFiles(x86)'], 'PuTTY', 'putty.exe')
      : undefined,
    environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, 'Programs', 'PuTTY', 'putty.exe')
      : undefined,
    'putty.exe',
  ];
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
};

const startFirstAvailable = async (
  candidates: readonly { readonly executable: string; readonly arguments_: readonly string[] }[],
  startProcess: StartProcess,
): Promise<void> => {
  for (const [index, candidate] of candidates.entries()) {
    try {
      await startProcess(candidate.executable, candidate.arguments_);
      return;
    } catch (error: unknown) {
      if (!isMissingExecutableError(error) || index === candidates.length - 1) {
        throw new ApplicationError(
          isMissingExecutableError(error)
            ? applicationErrorCodes.externalApplicationUnavailable
            : applicationErrorCodes.externalApplicationFailed,
        );
      }
    }
  }
  throw new ApplicationError(applicationErrorCodes.externalApplicationUnavailable);
};

export const openSshTerminal = async (
  profile: SftpConnectionProfile,
  configuredPuttyPath: string | null,
  options: SshTerminalOptions = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const startProcess = options.startProcess ?? startDetachedProcess;

  if (platform === 'win32' && (options.windowsClient ?? 'openssh') === 'openssh') {
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    const executables = [
      ...(systemRoot
        ? [win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
        : []),
      'powershell.exe',
    ];
    const arguments_ = createWindowsOpenSshCommand(profile, environment, options.directory);
    await startFirstAvailable(
      executables.map((executable) => ({ executable, arguments_ })),
      options.startProcess ?? startWindowsOpenSshProcess,
    );
    return;
  }

  if (platform === 'win32') {
    const commandPath = options.directory
      ? join(options.temporaryDirectory ?? tmpdir(), `openscp-ssh-${randomUUID()}.txt`)
      : undefined;
    if (commandPath && options.directory)
      await writeFile(commandPath, createRemoteShellCommand(options.directory), { mode: 0o600 });
    const cleanup = () => {
      if (commandPath) return unlink(commandPath).catch(() => undefined);
      return Promise.resolve();
    };
    try {
      await startFirstAvailable(
        windowsCandidates(configuredPuttyPath, environment).map((executable) => ({
          executable,
          arguments_: createPuttyArguments(profile, commandPath),
        })),
        commandPath
          ? (executable, arguments_) => startProcess(executable, arguments_, () => void cleanup())
          : startProcess,
      );
    } catch (error: unknown) {
      await cleanup();
      throw error;
    }
    return;
  }

  if (platform === 'darwin') {
    const scriptPath = join(
      options.temporaryDirectory ?? tmpdir(),
      `openscp-ssh-${randomUUID()}.command`,
    );
    await writeFile(scriptPath, createMacTerminalCommand(profile, scriptPath, options.directory), {
      mode: 0o700,
    });
    try {
      await startFirstAvailable(
        [{ executable: '/usr/bin/open', arguments_: ['-a', 'Terminal', scriptPath] }],
        startProcess,
      );
    } catch (error: unknown) {
      await unlink(scriptPath).catch(() => undefined);
      throw error;
    }
    return;
  }

  const sshArguments = createOpenSshArguments(profile, options.directory);
  await startFirstAvailable(
    [
      { executable: 'x-terminal-emulator', arguments_: ['-e', 'ssh', ...sshArguments] },
      { executable: 'gnome-terminal', arguments_: ['--', 'ssh', ...sshArguments] },
      { executable: 'konsole', arguments_: ['-e', 'ssh', ...sshArguments] },
      { executable: 'xterm', arguments_: ['-e', 'ssh', ...sshArguments] },
    ],
    startProcess,
  );
};
