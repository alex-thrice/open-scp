import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { nativeKeyringLaunchOptions } from './electron-launch';
import type { DesktopApi } from '../../src/shared/desktop-api';

const archive = JSON.stringify({
  version: 1,
  profiles: [
    {
      kind: 'icloud',
      group: '',
      profile: {
        id: null,
        name: 'Personal iCloud',
        remote: 'icloud',
        initialDirectory: '/',
        timeout: 1000,
      },
    },
  ],
});
const seedProfile = async (page: Page) => {
  await page.evaluate(async (content) => {
    const api = Reflect.get(globalThis, 'desktop') as DesktopApi;
    const result = await api.workspace({ action: 'import-profiles', content });
    if (!result.ok) throw new Error(result.error.code);
  }, archive);
};
const expectCreation = async (page: Page, available: boolean) => {
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await expect(page.getByLabel('Connection type').locator('option[value="icloud"]')).toHaveCount(
    available ? 1 : 0,
  );
  await page.getByRole('button', { name: '← All connections', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Connections', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click();
};
const expectSource = async (page: Page, available: boolean) => {
  await page.getByTestId('left-panel').getByRole('button', { name: 'Drive or connection' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Personal iCloud' })).toHaveCount(
    available ? 1 : 0,
  );
  await page.keyboard.press('Escape');
};

test('missing rclone hides iCloud creation and saved source options while preserving profiles', async () => {
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
    await seedProfile(window);
    await expectCreation(window, false);
    await expectSource(window, false);
    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await expectCreation(restored, false);
    await expectSource(restored, false);
    await restored.getByRole('button', { name: 'Connections', exact: true }).click();
    await restored.getByRole('button', { name: 'Edit: Personal iCloud', exact: true }).click();
    await expect(restored.getByLabel('Connection name in rclone')).toHaveValue('icloud');
    await restored.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(restored.getByRole('alert')).toContainText('rclone could not be started');
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('rclone settings immediately update availability and survive restart without contacting Apple', async () => {
  test.skip(
    !process.env.OPENSCP_TEST_RCLONE_BINARY,
    'Requires a selected rclone binary for local config discovery.',
  );
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'openscp-rclone-settings-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-rclone-settings-user-'));
  const config = join(root, 'rclone.conf');
  await writeFile(config, '[icloud]\ntype = iclouddrive\n');
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
        RCLONE_CONFIG: config,
      },
    });
  try {
    application = await launch();
    let window = await application.firstWindow();
    await seedProfile(window);
    await expectCreation(window, false);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('button', { name: 'Advanced', exact: true }).click();
    await window
      .getByLabel('rclone executable path')
      .fill(process.env.OPENSCP_TEST_RCLONE_BINARY ?? '');
    await window.getByRole('button', { name: 'Save rclone setting', exact: true }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await expectCreation(window, true);
    await expectSource(window, true);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('button', { name: 'Advanced', exact: true }).click();
    await mkdir(resolve('tests/fixtures/runtime'), { recursive: true });
    await window.getByLabel('rclone executable path').scrollIntoViewIfNeeded();
    await window.screenshot({ path: resolve('tests/fixtures/runtime/rclone-settings.png') });
    await application.close();
    await writeFile(config, '[other]\ntype = local\n');
    application = await launch();
    window = await application.firstWindow();
    await expectCreation(window, false);
    await expectSource(window, false);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(window.getByLabel('rclone executable path')).toHaveValue(
      process.env.OPENSCP_TEST_RCLONE_BINARY ?? '',
    );
    await application.close();
    await writeFile(config, '[icloud]\ntype = iclouddrive\n');
    application = await launch();
    window = await application.firstWindow();
    await expectCreation(window, true);
    await expectSource(window, true);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
