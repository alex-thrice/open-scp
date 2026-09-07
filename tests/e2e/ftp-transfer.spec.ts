import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createFtpProviderPath } from '../../src/shared/models/provider-path';
import { createFtpFixtureProvider } from '../integration/ftp-harness';
import { copySelection, finishProfile, newConnection, openConnection } from './workspace-ui';

test('saves an FTP profile, warns about plaintext and transfers through the shared queue', async () => {
  test.skip(process.env.OPENSCP_INTEGRATION !== '1', 'Requires the disposable FTP fixture.');
  test.setTimeout(90000);
  const localRoot = await mkdtemp(join(tmpdir(), 'openscp-ftp-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-ftp-user-'));
  const remoteRoot = `/data/ui-${randomUUID()}`;
  const fixture = createFtpFixtureProvider();
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
        OPENSCP_LOCAL_ROOT: localRoot,
      },
    });
  try {
    await fixture.provider.connect();
    await fixture.provider.createDirectory(createFtpProviderPath(remoteRoot));
    await mkdir(join(localRoot, 'downloads'));
    await writeFile(join(localRoot, 'ftp-ui-upload.txt'), 'Disposable FTP UI content.');
    application = await launch();
    let window = await application.firstWindow();
    const form = await newConnection(window, 'ftp');
    await expect(form.getByText(/Unencrypted FTP sends the password/u)).toBeVisible();
    await form.getByLabel('Profile name').fill('Disposable test FTP');
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Port', { exact: true }).fill('21210');
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await form.getByLabel('Initial directory').fill(remoteRoot);
    await finishProfile(window, form);
    await openConnection(window, 'right', 'Disposable test FTP');
    const passwordDialog = window.getByRole('dialog', { name: 'Connection password' });
    await expect(passwordDialog).toBeVisible();
    await passwordDialog.getByLabel('Password', { exact: true }).fill('wrong-fixture-password');
    await passwordDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      passwordDialog.getByText('Authentication failed. Check your credentials.'),
    ).toBeVisible();
    await passwordDialog.getByLabel('Password', { exact: true }).fill('fixture-ftp-password-only');
    await passwordDialog.getByLabel('Save password in secure system storage').check();
    await passwordDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(passwordDialog).toHaveCount(0);
    const remote = window.getByTestId('right-panel');
    const local = window.getByTestId('left-panel');
    await expect(remote.getByText(/Unencrypted FTP sends the password/u)).toBeVisible();
    await expect(remote.getByLabel('Current path')).toHaveValue(remoteRoot);
    await local.getByRole('row', { name: 'ftp-ui-upload.txt', exact: true }).click();
    await copySelection(window, local);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(1);
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await remote.getByRole('row', { name: 'ftp-ui-upload.txt', exact: true }).click();
    await local.getByRole('row', { name: 'Open downloads' }).dblclick();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(2);
    expect(await readFile(join(localRoot, 'downloads', 'ftp-ui-upload.txt'), 'utf8')).toBe(
      'Disposable FTP UI content.',
    );
    await application.close();
    application = undefined;
    expect(
      (await readFile(join(userData, 'settings.sqlite'))).includes(
        Buffer.from('fixture-ftp-password-only'),
      ),
    ).toBe(false);
    application = await launch();
    window = await application.firstWindow();
    await openConnection(window, 'right', 'Disposable test FTP');
    await expect(window.getByTestId('right-panel').getByLabel('Current path')).toHaveValue(
      remoteRoot,
    );
  } finally {
    await application?.close();
    await fixture.provider.connect();
    await fixture.provider.delete(createFtpProviderPath(remoteRoot), { recursive: true });
    await fixture.provider.disconnect();
    await rm(localRoot, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
