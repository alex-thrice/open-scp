import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { nativeKeyringLaunchOptions } from './electron-launch';
import type { DesktopApi } from '../../src/shared/desktop-api';
import { ipcRequestChannels } from '../../src/shared/ipc/channels';
import type { WorkspaceSnapshot } from '../../src/shared/ipc/workspace';

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
  await writeFile(config, '');
  const rcloneFolder = dirname(process.env.OPENSCP_TEST_RCLONE_BINARY ?? '');
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
    await window.getByLabel('rclone executable path').fill(rcloneFolder);
    await window.getByRole('button', { name: 'Save rclone setting', exact: true }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await expectCreation(window, true);
    await expectSource(window, false);
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await window.getByRole('button', { name: 'Connection', exact: true }).click();
    await window.getByLabel('Connection type').selectOption('icloud');
    await window.getByLabel('Account setup', { exact: true }).selectOption('existing');
    await expect(window.getByLabel('Connection name in rclone')).toBeDisabled();
    await expect(window.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
    await expect(
      window.getByRole('button', { name: 'Refresh connections', exact: true }),
    ).toBeEnabled();
    await window.getByRole('button', { name: 'Cancel', exact: true }).click();
    await window
      .getByRole('dialog', { name: 'Connections', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(window.getByRole('status')).toContainText('You can create an iCloud profile');
    await writeFile(config, '[icloud]\ntype = iclouddrive\n');
    await window.getByRole('button', { name: 'Check rclone', exact: true }).click();
    await expect(window.getByRole('status')).toContainText('Configured iCloud connections: 1');
    await mkdir(resolve('tests/fixtures/runtime'), { recursive: true });
    await window.getByLabel('rclone executable path').scrollIntoViewIfNeeded();
    await window.screenshot({ path: resolve('tests/fixtures/runtime/rclone-settings.png') });
    await window.getByRole('button', { name: 'Done', exact: true }).click();
    await expectSource(window, true);
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await window.getByRole('button', { name: 'Connection', exact: true }).click();
    await window.getByLabel('Connection type').selectOption('icloud');
    await window.getByLabel('Account setup', { exact: true }).selectOption('existing');
    await expect(window.getByLabel('Connection name in rclone')).toBeEnabled();
    await window.getByLabel('Connection name in rclone').selectOption('icloud');
    await window.getByLabel('Profile name', { exact: true }).fill('Existing iCloud');
    await window.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Edit: Existing iCloud', exact: true }),
    ).toBeVisible();
    await application.close();
    await writeFile(config, '[other]\ntype = local\n');
    application = await launch();
    window = await application.firstWindow();
    await expectCreation(window, true);
    await expectSource(window, false);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(window.getByLabel('rclone executable path')).toHaveValue(rcloneFolder);
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

test('iCloud sign-in form handles simulated 2FA, SMS selection, saving and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscp-icloud-wizard-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-icloud-wizard-user-'));
  const packagedPath = process.env.OPENSCP_PACKAGED_EXE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
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
        OPENSCP_RCLONE_PATH: join(root, 'missing-rclone.exe'),
      },
    });
    const page = await application.firstWindow();
    const snapshot = await page.evaluate(async () => {
      const response = await (Reflect.get(globalThis, 'desktop') as DesktopApi).workspace({
        action: 'snapshot',
      });
      if (!response.ok) throw new Error(response.error.code);
      return response.data.snapshot;
    });
    await application.evaluate(
      ({ ipcMain }, { channel, snapshot }) => {
        const state: WorkspaceSnapshot = { ...snapshot, rcloneAvailable: true, icloudRemotes: [] };
        let remote = '';
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, request) => {
          const payload = request.payload;
          const data: Record<string, unknown> = {
            snapshot: state,
            listing: null,
            privateKeyPath: null,
          };
          if (payload.action === 'start-icloud-configuration') {
            remote = payload.remote;
            data.icloudConfiguration = {
              id: payload.id,
              status: 'question',
              kind: 'verification-code',
              choices: [],
              retry: false,
            };
          } else if (payload.action === 'continue-icloud-configuration') {
            data.icloudConfiguration =
              payload.answer === '123456'
                ? { id: payload.id, status: 'complete' }
                : {
                    id: payload.id,
                    status: 'question',
                    kind:
                      payload.answer === 'sms'
                        ? 'phone'
                        : payload.answer === '1_sms'
                          ? 'sms-code'
                          : 'verification-code',
                    choices:
                      payload.answer === 'sms' ? [{ value: '1_sms', label: '+1 ••••12' }] : [],
                    retry: payload.answer === '000000',
                  };
            if (payload.answer === '123456') state.icloudRemotes = [remote];
          } else if (payload.action === 'begin-profile-edit')
            data.profileEditId = 'b13670f7-c900-41d8-a6b0-c4b1f7f961ba';
          else if (payload.action === 'save-icloud-profile') {
            state.profiles = [...state.profiles, { ...payload.profile, kind: 'icloud' }];
            data.savedProfileId = payload.profile.id;
          }
          return { correlationId: request.correlationId, ok: true, data };
        });
      },
      { channel: ipcRequestChannels.workspace, snapshot },
    );
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await page.getByLabel('Connection type').selectOption('icloud');
    await page.getByLabel('Profile name', { exact: true }).fill('GUI Apple account');
    await expect(page.getByLabel('Connection name in rclone')).toBeDisabled();
    await page.getByLabel('Apple Account email').fill('gui+tag@example.invalid');
    await expect(page.getByLabel('Connection name in rclone')).toHaveValue(
      'gui+tag@example.invalid',
    );
    await page.getByLabel('Apple Account password').fill('gui-password-canary');
    await page
      .getByRole('dialog')
      .screenshot({ path: test.info().outputPath('icloud-account-form.png') });
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByLabel('Verification code')).toBeFocused();
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The answer was not accepted');
    await page.getByRole('button', { name: 'Send code by SMS', exact: true }).click();
    await expect(page.getByLabel('Trusted phone number')).toHaveValue('1_sms');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('sent by SMS');
    await page
      .getByRole('dialog')
      .screenshot({ path: test.info().outputPath('icloud-verification.png') });
    await page.getByLabel('Verification code').fill('123456');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Edit: GUI Apple account', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit: GUI Apple account', exact: true }).click();
    await expect(page.getByLabel('Connection name in rclone')).toBeEnabled();
    await expect(
      page.getByRole('combobox', { name: 'Connection name in rclone', exact: true }),
    ).toHaveValue('gui+tag@example.invalid');
    await page
      .getByRole('dialog')
      .screenshot({ path: test.info().outputPath('icloud-existing-connections.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await page.getByLabel('Connection type').selectOption('icloud');
    await page.getByLabel('Profile name', { exact: true }).fill('Cancelled account');
    await page.getByLabel('Apple Account email').fill('cancelled@example.invalid');
    await page.getByLabel('Apple Account password').fill('cancel-password-canary');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Edit: Cancelled account', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Edit: GUI Apple account', exact: true }),
    ).toBeVisible();
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
