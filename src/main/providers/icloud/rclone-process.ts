import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ICloudConnectionProfile } from '@shared/models/connection-profile';
import type { ProviderOperation } from '@shared/providers/provider-error';
import { ProviderError, providerErrorCodes } from '@shared/providers/provider-error';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import { icloudRemoteSchema } from '@shared/models/icloud-profile';

export interface RcloneConfigurationInput {
  readonly state: string;
  readonly result: string;
}

export type RcloneLauncher = (
  args: readonly string[],
  input?: RcloneConfigurationInput,
) => ChildProcessWithoutNullStreams;

export const createRcloneLauncher =
  (profile: ICloudConnectionProfile, configuredPath?: () => string | undefined): RcloneLauncher =>
  (args, input) => {
    let executable = configuredPath?.() || process.env.OPENSCP_RCLONE_PATH || 'rclone';
    if (executable !== 'rclone' && !isAbsolute(executable))
      throw new ApplicationError(applicationErrorCodes.rcloneUnavailable);
    if (executable !== 'rclone' && statSync(executable, { throwIfNoEntry: false })?.isDirectory())
      executable = join(executable, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
    // Исключаем унаследованные фильтры, dry-run и другие настройки операций rclone.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^RCLONE_/iu.test(name) || /^RCLONE_CONFIG(?:_PASS)?$/iu.test(name),
      ),
    );
    env[`RCLONE_CONFIG_${profile.remote.toUpperCase()}_SERVICE`] = 'drive';
    if (input) {
      env.RCLONE_STATE = input.state;
      env.RCLONE_RESULT = input.result;
    }
    return spawn(executable, [...args], { shell: false, windowsHide: true, stdio: 'pipe', env });
  };

export const icloudFailure = (
  code: keyof typeof providerErrorCodes,
  operation: ProviderOperation,
): ProviderError => new ProviderError(providerErrorCodes[code], { provider: 'icloud', operation });

const exitFailure = (code: number | null, stderr: string, operation: ProviderOperation) => {
  if (code === 3 || code === 4) return icloudFailure('notFound', operation);
  if (
    /failed to load config|config file is encrypted|unable to read password|couldn't decrypt/iu.test(
      stderr,
    )
  )
    return new ApplicationError(applicationErrorCodes.rcloneConfiguration);
  if (/i\/o timeout|connection timed out|context deadline exceeded/iu.test(stderr))
    return new ApplicationError(applicationErrorCodes.rcloneTimeout);
  if (
    /trust token expired|reauth|requires? 2fa|two.factor|validate2FACode|ValidateSMSCode|incorrect password|authentication failed|failed to authenticate|invalid credentials|login required|sign.?in failed|PCS cookie|\b(?:401|421)\b/iu.test(
      stderr,
    )
  )
    return new ApplicationError(applicationErrorCodes.rcloneAuthentication);
  if (/quota|insufficient storage|not enough space/iu.test(stderr))
    return icloudFailure('quotaExceeded', operation);
  if (/rate.limit|too many requests|\b429\b/iu.test(stderr))
    return icloudFailure('rateLimited', operation);
  if (/access denied|permission denied|\b403\b/iu.test(stderr))
    return icloudFailure('accessDenied', operation);
  if (/immutable|already exists|directory not empty/iu.test(stderr))
    return icloudFailure('conflict', operation);
  return icloudFailure('ioError', operation);
};

export interface RcloneCommand {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  readonly abort: () => void;
}

export class RcloneProcess {
  private readonly commands = new Set<RcloneCommand>();
  private readonly launch: RcloneLauncher;

  public constructor(
    private readonly profile: ICloudConnectionProfile,
    launch?: RcloneLauncher,
  ) {
    this.launch = launch ?? createRcloneLauncher(profile);
  }

  public start(
    args: readonly string[],
    operation: ProviderOperation,
    signal?: AbortSignal,
    metadata = false,
    input?: RcloneConfigurationInput,
  ): RcloneCommand {
    if (signal?.aborted) throw icloudFailure('cancelled', operation);
    const timeout = this.profile.timeout ?? 60000;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(
        [
          ...args,
          '--ask-password=false',
          '--log-level=ERROR',
          '--stats=0',
          '--retries=1',
          '--low-level-retries=1',
          `--contimeout=${timeout}ms`,
          `--timeout=${timeout}ms`,
          '--buffer-size=1M',
          '--multi-thread-streams=0',
        ],
        input,
      );
    } catch {
      throw new ApplicationError(applicationErrorCodes.rcloneUnavailable);
    }
    let stderr = '';
    let stopped: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      stopped ??= icloudFailure('cancelled', operation);
      child.kill();
    };
    const done = new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-65536);
      });
      child.stdin.on('error', () => undefined);
      child.stdout.on('error', () => undefined);
      child.once('error', () => {
        reject(stopped ?? new ApplicationError(applicationErrorCodes.rcloneUnavailable));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.commands.delete(command);
        if (stopped) reject(stopped);
        else if (code === 0) resolve();
        else reject(exitFailure(code, stderr, operation));
        stderr = '';
      });
    });
    const command = { child, done, abort };
    this.commands.add(command);
    void done.catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (metadata) {
      timer = setTimeout(() => {
        stopped ??= new ApplicationError(applicationErrorCodes.rcloneTimeout);
        child.kill();
      }, timeout);
      timer.unref();
    }
    return command;
  }

  public async output(
    args: readonly string[],
    operation: ProviderOperation,
    signal?: AbortSignal,
    input?: RcloneConfigurationInput,
    stdin?: string,
  ): Promise<string> {
    const command = this.start(args, operation, signal, true, input);
    command.child.stdin.end(stdin);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of command.child.stdout) {
        const buffer = Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > 16 * 1024 * 1024) {
          command.abort();
          throw icloudFailure('ioError', operation);
        }
        chunks.push(buffer);
      }
      await command.done;
      return Buffer.concat(chunks).toString();
    } catch (error) {
      command.abort();
      await command.done.catch(() => undefined);
      throw error;
    }
  }

  public async json(
    args: readonly string[],
    operation: ProviderOperation,
    signal?: AbortSignal,
    input?: RcloneConfigurationInput,
  ): Promise<unknown> {
    const output = await this.output(args, operation, signal, input);
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw icloudFailure('ioError', operation);
    }
  }

  public async icloudRemotes(signal?: AbortSignal): Promise<readonly string[]> {
    const output = await this.output(['listremotes', '--long'], 'connect', signal);
    return [
      ...new Set(
        output.split(/\r?\n/u).flatMap((line) => {
          const match = /^(.*):\s+iclouddrive\s*$/u.exec(line);
          if (!match) return [];
          const remote = icloudRemoteSchema.safeParse(match[1]);
          return remote.success ? [remote.data] : [];
        }),
      ),
    ];
  }

  public async run(
    args: readonly string[],
    operation: ProviderOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    const command = this.start(args, operation, signal, true);
    command.child.stdin.end();
    command.child.stdout.resume();
    await command.done;
  }

  public async close(): Promise<void> {
    const commands = [...this.commands];
    for (const command of commands) command.abort();
    await Promise.allSettled(commands.map((command) => command.done));
  }
}
