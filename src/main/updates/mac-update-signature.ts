import { execFile } from 'node:child_process';

export type CodesignRunner = (argumentsList: readonly string[]) => Promise<string>;

const runCodesign: CodesignRunner = (argumentsList) =>
  new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/codesign',
      [...argumentsList],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) reject(error);
        else resolve(stderr);
      },
    );
  });

export const hasRequiredMacUpdateSignature = async (
  applicationPath: string,
  codesign: CodesignRunner = runCodesign,
): Promise<boolean> => {
  try {
    await codesign(['--verify', '--deep', '--strict', applicationPath]);
    const details = await codesign(['--display', '--verbose=4', applicationPath]);
    return (
      /^Authority=Developer ID Application:/mu.test(details) &&
      /^TeamIdentifier=(?!not set$)\S+/mu.test(details)
    );
  } catch {
    return false;
  }
};
