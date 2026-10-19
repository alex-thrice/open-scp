import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { nativeKeyringLaunchOptions } from './electron-launch';
import { finishProfile } from './workspace-ui';

test('iCloud profile setup, useful missing-rclone feedback and persistence', async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'openscp-icloud-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-icloud-user-'));
  const packagedPath = process.env.OPENSCP_PACKAGED_EXE;
  let application: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      ...nativeKeyringLaunchOptions(packagedPath),
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        '--no-sandbox',
        `--user-data-dir=${userData}`,
        ...(packagedPath ? [] : [resolve('out/main/index.js')]),
      ],
      env: {
        ...process.env,
        OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
        OPENSCP_LOCAL_ROOT: root,
        OPENSCP_RCLONE_PATH: join(root, 'not-installed-rclone.exe'),
      },
    });
  try {
    application = await launch();
    const window = await application.firstWindow();
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await window.getByRole('button', { name: 'Connection', exact: true }).click();
    await window.getByLabel('Connection type').selectOption('icloud');
    const form = window.getByRole('dialog', { name: 'iCloud Drive connection', exact: true });
    await form.getByLabel('Profile name').fill('Personal iCloud');
    await expect(form.getByLabel('Connection name in rclone')).toHaveValue('icloud');
    await expect(form.locator('input[type="password"]')).toHaveCount(0);
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('rclone could not be started');
    await mkdir(resolve('tests/fixtures/runtime'), { recursive: true });
    await window.screenshot({ path: resolve('tests/fixtures/runtime/icloud-profile.png') });
    await finishProfile(window, form);
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Edit: Personal iCloud', exact: true }),
    ).toBeVisible();
    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await restored.getByRole('button', { name: 'Connections', exact: true }).click();
    await restored.getByRole('button', { name: 'Edit: Personal iCloud', exact: true }).click();
    await expect(restored.getByLabel('Connection name in rclone')).toHaveValue('icloud');
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
