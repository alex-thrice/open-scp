import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export const nativeKeyringLaunchOptions = (packagedPath?: string) => {
  // Playwright's development loader overwrites password-store with basic.
  // An explicit executable skips that loader and preserves the real Linux keyring.
  const executablePath =
    packagedPath ??
    (process.platform === 'linux'
      ? (createRequire(resolve('package.json'))('electron') as string)
      : undefined);
  return executablePath ? { executablePath } : {};
};
