import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { startYandexFixture } from '../fixtures/yandex-fixture';
import { copySelection, finishProfile, newConnection, openConnection } from './workspace-ui';
import { nativeKeyringLaunchOptions } from './electron-launch';

test('Yandex browser authorization, queue, restart, sign-out and cancellation', async () => {
  test.setTimeout(90000);
  const fixture = await startYandexFixture();
  const localRoot = await mkdtemp(join(tmpdir(), 'openscp-yandex-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-yandex-user-'));
  let application: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      ...nativeKeyringLaunchOptions(),
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
        OPENSCP_LOCAL_ROOT: localRoot,
        OPENSCP_YANDEX_FIXTURE: '1',
        OPENSCP_TEST_YANDEX_ENDPOINT: fixture.endpoint,
      },
    });
  try {
    await mkdir(join(localRoot, 'downloads'));
    await writeFile(join(localRoot, 'yandex-upload.txt'), 'Disposable Yandex UI content.');
    application = await launch();
    let window = await application.firstWindow();
    const form = await newConnection(window, 'yandex');
    await form.getByLabel('Profile name').fill('Disposable Yandex');
    await expect(form.getByLabel('Password', { exact: true })).toHaveCount(0);
    fixture.authorizationMode = 'stall';
    await form.getByRole('button', { name: 'Sign in to Yandex', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Sign in to Yandex', exact: true }),
    ).toBeVisible();
    fixture.authorizationMode = 'normal';
    await form.getByRole('button', { name: 'Sign in to Yandex', exact: true }).click();
    await expect(form.getByText('Yandex account: fixture-one', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.locator('.dialog-notice .connection-feedback--success')).toHaveText(
      'Connection successful. The initial location is accessible.',
    );
    await window.screenshot({ path: resolve('tests/fixtures/runtime/yandex-profile.png') });
    await finishProfile(window, form);
    await openConnection(window, 'right', 'Disposable Yandex');
    const remote = window.getByTestId('right-panel');
    const local = window.getByTestId('left-panel');
    await expect(remote.getByLabel('Current path')).toHaveValue('/');
    await local.getByRole('row', { name: 'yandex-upload.txt', exact: true }).click();
    await copySelection(window, local);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(1);
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await remote.getByRole('row', { name: 'yandex-upload.txt', exact: true }).click();
    await local.getByRole('row', { name: 'Open downloads' }).dblclick();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(2);
    expect(await readFile(join(localRoot, 'downloads', 'yandex-upload.txt'), 'utf8')).toBe(
      'Disposable Yandex UI content.',
    );
    await window.screenshot({ path: resolve('tests/fixtures/runtime/yandex-workspace.png') });
    await application.close();
    application = undefined;
    const database = await readFile(join(userData, 'settings.sqlite'));
    expect(database.includes(Buffer.from('fixture-access-'))).toBe(false);
    expect(database.includes(Buffer.from('fixture-refresh-'))).toBe(false);
    const logins = fixture.requests.filter((entry) => entry.path === '/authorize').length;
    application = await launch();
    window = await application.firstWindow();
    await openConnection(window, 'right', 'Disposable Yandex');
    await expect(
      window
        .getByTestId('right-panel')
        .getByRole('row', { name: 'yandex-upload.txt', exact: true }),
    ).toBeVisible();
    expect(fixture.requests.filter((entry) => entry.path === '/authorize')).toHaveLength(logins);
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await window.getByRole('button', { name: 'Edit: Disposable Yandex', exact: true }).click();
    const edit = window.getByRole('dialog', { name: 'Connections', exact: true });
    await edit.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(edit.getByText('Not signed in to Yandex', { exact: true })).toBeVisible();
    await edit.getByRole('button', { name: '← All connections', exact: true }).click();
    await window
      .getByRole('dialog', { name: 'Connections', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    await openConnection(window, 'right', 'Disposable Yandex');
    const login = window.getByRole('dialog', { name: 'Yandex Disk sign-in', exact: true });
    await expect(login).toBeVisible();
    await login.getByRole('button', { name: 'Sign in to Yandex', exact: true }).click();
    await expect(login).toHaveCount(0);
    await expect(
      window
        .getByTestId('right-panel')
        .getByRole('row', { name: 'yandex-upload.txt', exact: true }),
    ).toBeVisible();
  } finally {
    await application?.close();
    await fixture.close();
    await rm(localRoot, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
