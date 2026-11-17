import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

test('SSH client selection survives restarts and preserves the alternate PuTTY path', async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'openscp-ssh-settings-root-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-ssh-settings-user-'));
  let application: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        '--no-sandbox',
        `--user-data-dir=${userData}`,
        resolve('out/main/index.js'),
      ],
      env: {
        ...process.env,
        OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
        OPENSCP_LOCAL_ROOT: root,
      },
    });
  const openSettings = async () => {
    if (!application) throw new Error('Expected a running Electron application.');
    const window = await application.firstWindow();
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('button', { name: 'Advanced', exact: true }).click();
    return window;
  };
  try {
    application = await launch();
    let window = await openSettings();
    await expect(window.getByLabel('SSH client (Windows)', { exact: true })).toHaveValue('openssh');
    await expect(window.getByLabel('PuTTY executable path (Windows)')).toBeDisabled();
    await window.getByLabel('SSH client (Windows)', { exact: true }).selectOption('putty');
    const puttyPath = 'C:\\Tools\\PuTTY\\putty.exe';
    await window.getByLabel('PuTTY executable path (Windows)').fill(puttyPath);
    await window.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await application.close();

    application = await launch();
    window = await openSettings();
    await expect(window.getByLabel('SSH client (Windows)', { exact: true })).toHaveValue('putty');
    await expect(window.getByLabel('PuTTY executable path (Windows)')).toHaveValue(puttyPath);
    await window.getByLabel('SSH client (Windows)', { exact: true }).selectOption('openssh');
    await window.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await application.close();

    application = await launch();
    window = await openSettings();
    await expect(window.getByLabel('SSH client (Windows)', { exact: true })).toHaveValue('openssh');
    await expect(window.getByLabel('PuTTY executable path (Windows)')).toHaveValue(puttyPath);
    await expect(window.getByLabel('PuTTY executable path (Windows)')).toBeDisabled();
    await window.screenshot({ path: test.info().outputPath('ssh-terminal-settings.png') });
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
