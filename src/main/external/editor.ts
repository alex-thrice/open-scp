import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';

type StartProcess = (executable: string, arguments_: readonly string[]) => Promise<void>;

export interface EditorOptions {
  readonly platform?: NodeJS.Platform;
  readonly startProcess?: StartProcess;
}

const startDetachedProcess: StartProcess = (executable, arguments_) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

const isMissingExecutableError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

const startFirstAvailable = async (
  candidates: readonly { readonly executable: string; readonly arguments_: readonly string[] }[],
  startProcess: StartProcess,
): Promise<void> => {
  for (const [index, candidate] of candidates.entries()) {
    try {
      await startProcess(candidate.executable, candidate.arguments_);
      return;
    } catch (error: unknown) {
      if (!isMissingExecutableError(error) || index === candidates.length - 1)
        throw new ApplicationError(
          isMissingExecutableError(error)
            ? applicationErrorCodes.externalApplicationUnavailable
            : applicationErrorCodes.externalApplicationFailed,
        );
    }
  }
};

export const openEditor = async (
  filePath: string,
  configuredPath: string | null,
  options: EditorOptions = {},
): Promise<void> => {
  const startProcess = options.startProcess ?? startDetachedProcess;
  const platform = options.platform ?? process.platform;
  if (configuredPath) {
    const isAbsolutePath = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
    if (!isAbsolutePath(configuredPath))
      throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
    await startFirstAvailable(
      [{ executable: configuredPath, arguments_: [filePath] }],
      startProcess,
    );
    return;
  }

  if (platform === 'win32') {
    await startFirstAvailable(
      [{ executable: 'notepad.exe', arguments_: [filePath] }],
      startProcess,
    );
    return;
  }
  if (platform === 'darwin') {
    await startFirstAvailable(
      [{ executable: '/usr/bin/open', arguments_: ['-a', 'TextEdit', filePath] }],
      startProcess,
    );
    return;
  }
  await startFirstAvailable(
    ['gedit', 'kate', 'xed', 'mousepad', 'xdg-open'].map((executable) => ({
      executable,
      arguments_: [filePath],
    })),
    startProcess,
  );
};
