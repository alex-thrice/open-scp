import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { googleFixtureEntry } from '../fixtures/google-fixture';
import { googleChildPath, googleRootPath } from '../../src/shared/models/google-path';
import { startGoogleFixture } from '../fixtures/google-fixture';
import { copySelection, finishProfile, newConnection, openConnection } from './workspace-ui';
import { nativeKeyringLaunchOptions } from './electron-launch';

test('Google browser authorization, queue, restart, sign-out and cancellation', async () => {
  test.setTimeout(90000);
  const fixture = await startGoogleFixture();
  const localRoot = await mkdtemp(join(tmpdir(), 'openscp-google-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-google-user-'));
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
        OPENSCP_GOOGLE_FIXTURE: '1',
        OPENSCP_TEST_GOOGLE_ENDPOINT: fixture.endpoint,
      },
    });
  try {
    await mkdir(join(localRoot, 'downloads'));
    await writeFile(join(localRoot, 'google-upload.txt'), 'Disposable Google UI content.');
    application = await launch();
    let window = await application.firstWindow();
    const form = await newConnection(window, 'google');
    await form.getByLabel('Profile name').fill('Disposable Google');
    await expect(form.getByLabel('Password', { exact: true })).toHaveCount(0);
    fixture.authorizationMode = 'stall';
    await form.getByRole('button', { name: 'Sign in to Google', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Sign in to Google', exact: true }),
    ).toBeVisible();
    fixture.authorizationMode = 'normal';
    await form.getByRole('button', { name: 'Sign in to Google', exact: true }).click();
    await expect(
      form.getByText('Google account: fixture-one@example.test', { exact: true }),
    ).toBeVisible();
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.locator('.dialog-notice .connection-feedback--success')).toHaveText(
      'Connection successful. The initial location is accessible.',
    );
    await window.screenshot({ path: resolve('tests/fixtures/runtime/google-profile.png') });
    await finishProfile(window, form);
    await openConnection(window, 'right', 'Disposable Google');
    const remote = window.getByTestId('right-panel');
    const local = window.getByTestId('left-panel');
    await expect(remote.getByLabel('Current path')).toHaveValue('/My Drive');
    await local.getByRole('row', { name: 'google-upload.txt', exact: true }).click();
    await copySelection(window, local);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(1);
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await remote.getByRole('row', { name: 'google-upload.txt', exact: true }).click();
    await local.getByRole('row', { name: 'Open downloads' }).dblclick();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(2);
    expect(await readFile(join(localRoot, 'downloads', 'google-upload.txt'), 'utf8')).toBe(
      'Disposable Google UI content.',
    );
    await window.screenshot({ path: resolve('tests/fixtures/runtime/google-workspace.png') });
    const tree = fixture.accounts.get('one');
    if (!tree) throw new Error('No account tree');
    const first = googleFixtureEntry('duplicate.txt', 'first');
    const second = googleFixtureEntry('duplicate.txt', 'second');
    tree.set(first.id, first);
    tree.set(second.id, second);
    await writeFile(join(localRoot, 'downloads', 'duplicate.txt'), 'replacement');
    await local.getByRole('button', { name: 'Refresh', exact: true }).click();
    await local.getByRole('row', { name: 'duplicate.txt', exact: true }).click();
    await copySelection(window, local);
    const conflict = window.getByRole('alertdialog');
    await expect(conflict).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Overwrite', exact: true })).toBeDisabled();
    await conflict
      .getByLabel('Choose the file to replace (ID)')
      .selectOption(googleChildPath(googleRootPath, 'duplicate.txt', second.id));
    await conflict.getByRole('button', { name: 'Overwrite', exact: true }).click();
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(3);
    expect(first.content.toString()).toBe('first');
    expect(second.content.toString()).toBe('replacement');
    const doc = googleFixtureEntry('Report', 'native');
    doc.mimeType = 'application/vnd.google-apps.document';
    tree.set(doc.id, doc);
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(remote.getByRole('row', { name: 'duplicate.txt', exact: true })).toHaveCount(2);
    await remote.getByRole('row', { name: 'Report', exact: true }).click();
    await expect(remote.getByRole('button', { name: /^Copy to /u })).toBeDisabled();
    await remote.getByRole('button', { name: 'Export document…', exact: true }).click();
    const exporting = window.getByRole('dialog', { name: 'Export document…', exact: true });
    await exporting.getByLabel('Export format').selectOption('application/pdf');
    await exporting.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(4);
    expect(await readFile(join(localRoot, 'downloads', 'Report.pdf'), 'utf8')).toBe(
      `export:${doc.id}:application/pdf`,
    );
    await window.screenshot({ path: resolve('tests/fixtures/runtime/google-export.png') });
    await application.close();
    application = undefined;
    const database = await readFile(join(userData, 'settings.sqlite'));
    expect(database.includes(Buffer.from('fixture-access-'))).toBe(false);
    expect(database.includes(Buffer.from('fixture-refresh-'))).toBe(false);
    const logins = fixture.requests.filter((entry) => entry.path === '/authorize').length;
    application = await launch();
    window = await application.firstWindow();
    await openConnection(window, 'right', 'Disposable Google');
    await expect(
      window
        .getByTestId('right-panel')
        .getByRole('row', { name: 'google-upload.txt', exact: true }),
    ).toBeVisible();
    expect(fixture.requests.filter((entry) => entry.path === '/authorize')).toHaveLength(logins);
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await window.getByRole('button', { name: 'Edit: Disposable Google', exact: true }).click();
    const edit = window.getByRole('dialog', { name: 'Connections', exact: true });
    await edit.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(edit.getByText('Not signed in to Google', { exact: true })).toBeVisible();
    await edit.getByRole('button', { name: '← All connections', exact: true }).click();
    await window
      .getByRole('dialog', { name: 'Connections', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    await openConnection(window, 'right', 'Disposable Google');
    const login = window.getByRole('dialog', { name: 'Google Drive sign-in', exact: true });
    await expect(login).toBeVisible();
    await login.getByRole('button', { name: 'Sign in to Google', exact: true }).click();
    await expect(login).toHaveCount(0);
    await expect(
      window
        .getByTestId('right-panel')
        .getByRole('row', { name: 'google-upload.txt', exact: true }),
    ).toBeVisible();
  } finally {
    await application?.close();
    await fixture.close();
    await rm(localRoot, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
