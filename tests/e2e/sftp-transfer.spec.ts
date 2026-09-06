import { newConnection, finishProfile, openConnection, copySelection } from './workspace-ui';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createFixtureProvider, trustFixture } from '../integration/sftp-harness';
import { createSftpProviderPath } from '../../src/shared/models/provider-path';

test('saves a secure SFTP profile, confirms identity and transfers in both directions', async () => {
  test.skip(process.env.OPENSCP_INTEGRATION !== '1', 'Requires the disposable OpenSSH fixture.');
  test.setTimeout(60000);
  const localRoot = await mkdtemp(join(tmpdir(), 'openscp-sftp-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-sftp-user-'));
  const remoteRoot = `/home/fixture/data/ui-${randomUUID()}`;
  const fixture = createFixtureProvider();
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
    await trustFixture(fixture);
    await fixture.provider.connect();
    await fixture.provider.createDirectory(createSftpProviderPath(remoteRoot));
    await mkdir(join(localRoot, 'downloads'));
    await writeFile(join(localRoot, 'ui-upload.txt'), 'Disposable UI roundtrip content.');
    application = await launch();
    let window = await application.firstWindow();
    const form = await newConnection(window, 'sftp');
    await form.getByLabel('Profile name').fill('Disposable test SFTP');
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Port', { exact: true }).fill('22222');
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await form.getByLabel('Password', { exact: true }).fill('fixture-password-only');
    await form.getByLabel('Initial directory').fill(remoteRoot);
    await finishProfile(window, form);
    await openConnection(window, 'right', 'Disposable test SFTP');
    await expect(window.getByText(/Unknown server key/u)).toBeVisible();
    await window.getByRole('button', { name: 'Trust this key and connect' }).click();
    const remote = window.getByTestId('right-panel');
    const local = window.getByTestId('left-panel');
    await expect(remote.getByLabel('Current path')).toBeVisible();
    await remote.getByRole('button', { name: 'New directory', exact: true }).click();
    let operation = window.getByRole('dialog', { name: 'New directory' });
    await operation.getByLabel('Name', { exact: true }).fill('UI directory');
    await operation.getByRole('button', { name: 'Confirm' }).click();
    await remote.getByRole('row', { name: 'Open UI directory' }).click();
    await remote.getByRole('button', { name: 'Rename', exact: true }).click();
    operation = window.getByRole('dialog', { name: 'Rename' });
    await operation.getByLabel('Name', { exact: true }).fill('UI renamed');
    await operation.getByRole('button', { name: 'Confirm' }).click();
    await remote.getByRole('row', { name: 'Open UI renamed' }).click();
    await remote.getByRole('button', { name: 'Delete', exact: true }).click();
    await window
      .getByRole('dialog', { name: 'Delete' })
      .getByRole('button', { name: 'Confirm' })
      .click();
    await expect(remote.getByRole('row', { name: 'Open UI renamed' })).toHaveCount(0);
    await local.getByRole('row', { name: 'ui-upload.txt', exact: true }).click();
    await copySelection(window, local);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(1);
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await remote.getByRole('row', { name: 'ui-upload.txt', exact: true }).click();
    await local.getByRole('row', { name: 'Open downloads' }).dblclick();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(2);
    await expect(local.getByRole('row', { name: 'ui-upload.txt', exact: true })).toBeVisible();
    expect(await readFile(join(localRoot, 'downloads', 'ui-upload.txt'), 'utf8')).toBe(
      'Disposable UI roundtrip content.',
    );
    await window.screenshot({ path: test.info().outputPath('sftp-transfer.png') });
    await application.close();
    application = undefined;
    expect(
      (await readFile(join(userData, 'settings.sqlite'))).includes(
        Buffer.from('fixture-password-only'),
      ),
    ).toBe(false);
    application = await launch();
    window = await application.firstWindow();
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Disposable test SFTP', exact: true }),
    ).toBeVisible();
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    await openConnection(window, 'right', 'Disposable test SFTP');
    await expect(window.getByTestId('right-panel').getByLabel('Current path')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Trust this key and connect' })).toHaveCount(0);
  } finally {
    await application?.close();
    await fixture.provider.connect();
    await fixture.provider.delete(createSftpProviderPath(remoteRoot), { recursive: true });
    await fixture.provider.disconnect();
    await rm(localRoot, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
