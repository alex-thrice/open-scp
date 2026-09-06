import { newConnection, finishProfile, openConnection, copySelection } from './workspace-ui';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createMinioProvider } from '../integration/s3-harness';
import { createS3ProviderPath } from '../../src/shared/models/provider-path';

test('persists a secure S3 profile, round-trips a file and confirms prefix deletion', async () => {
  test.skip(process.env.OPENSCP_INTEGRATION !== '1', 'Requires disposable MinIO.');
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'openscp-s3-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-s3-ui-user-'));
  const prefix = `ui-${randomUUID()}/`;
  const fixture = createMinioProvider();
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
  try {
    await fixture.connect();
    await fixture.createDirectory(createS3ProviderPath('fixture-bucket', prefix));
    await mkdir(join(root, 'downloads'));
    await writeFile(join(root, 's3-upload.txt'), 'Disposable S3 UI content.');
    application = await launch();
    let window = await application.firstWindow();
    const form = await newConnection(window, 's3');
    await form.getByLabel('Profile name').fill('Disposable UI MinIO');
    await form.getByLabel('Endpoint (blank for AWS)').fill('http://127.0.0.1:29000');
    await form.getByLabel('Bucket (blank to list buckets)').fill('fixture-bucket');
    await form.getByLabel('Initial prefix').fill(prefix);
    await form.getByLabel('Path-style addressing').check();
    await form.getByLabel('Access key ID', { exact: true }).fill('fixture-access-only');
    await form
      .getByLabel('Secret access key', { exact: true })
      .fill('fixture-secret-only-not-production');
    await finishProfile(window, form);
    await openConnection(window, 'right', 'Disposable UI MinIO');
    const local = window.getByRole('tabpanel').getByTestId('left-panel');
    const remote = window.getByRole('tabpanel').getByTestId('right-panel');
    await expect(remote.getByLabel('Current path')).toBeVisible();
    await window.getByRole('button', { name: 'New workspace' }).click();
    await openConnection(window, 'right', 'Disposable UI MinIO');
    await expect(remote.getByLabel('Current path')).toBeVisible();
    await window.getByRole('button', { name: 'New workspace' }).click();
    const sftpForm = await newConnection(window, 'sftp');
    await sftpForm.getByLabel('Profile name').fill('Concurrent SFTP');
    await sftpForm.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await sftpForm.getByLabel('Port', { exact: true }).fill('22222');
    await sftpForm.getByLabel('Username', { exact: true }).fill('fixture');
    await sftpForm.getByLabel('Password', { exact: true }).fill('fixture-password-only');
    await sftpForm.getByLabel('Initial directory').fill('/home/fixture/data');
    await finishProfile(window, sftpForm);
    await openConnection(window, 'right', 'Concurrent SFTP');
    await remote.getByRole('button', { name: 'Trust this key and connect' }).click();
    await expect(remote.getByLabel('Current path')).toHaveValue(/fixture/u);
    const s3Tabs = window.getByRole('tab', { name: / - Disposable UI MinIO$/u });
    await expect(s3Tabs).toHaveCount(2);
    await s3Tabs.nth(1).click();
    await expect(remote.getByLabel('Current path')).toHaveValue(/fixture-bucket/u);
    await s3Tabs.first().click();
    await expect(remote.getByLabel('Current path')).toHaveValue(/fixture-bucket/u);
    await expect(remote.getByRole('button', { name: 'Drive or connection' })).toBeDisabled();
    await local.getByRole('row', { name: 's3-upload.txt', exact: true }).click();
    await copySelection(window, local);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(1);
    await remote.getByRole('row', { name: 's3-upload.txt', exact: true }).click();
    await expect(remote.getByText('Object', { exact: true })).toBeVisible();
    await local.getByRole('row', { name: 'Open downloads' }).dblclick();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(2);
    expect(await readFile(join(root, 'downloads', 's3-upload.txt'), 'utf8')).toBe(
      'Disposable S3 UI content.',
    );
    await fixture.createDirectory(createS3ProviderPath('fixture-bucket', prefix + 'copied/'));
    await openConnection(window, 'left', 'Disposable UI MinIO');
    await local.getByRole('row', { name: 'Open copied', exact: true }).dblclick();
    await remote.getByRole('row', { name: 's3-upload.txt', exact: true }).click();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(3);
    await expect(local.getByRole('row', { name: 's3-upload.txt', exact: true })).toBeVisible();
    await remote.getByRole('row', { name: 's3-upload.txt', exact: true }).click();
    await remote.getByRole('button', { name: 'Rename', exact: true }).click();
    let dialog = window.getByRole('dialog', { name: 'Rename', exact: true });
    await expect(dialog.getByText(/S3 rename is not atomic/u)).toBeVisible();
    await dialog.getByLabel('Name', { exact: true }).fill('s3-renamed.txt');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await remote.getByRole('button', { name: 'New directory', exact: true }).click();
    dialog = window.getByRole('dialog', { name: 'New directory', exact: true });
    await dialog.getByLabel('Name', { exact: true }).fill('empty-prefix');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await remote.getByRole('row', { name: 'Open empty-prefix', exact: true }).click();
    await remote.getByRole('button', { name: 'Delete', exact: true }).click();
    dialog = window.getByRole('dialog', { name: 'Delete', exact: true });
    await expect(dialog.getByText('1 object · 0 bytes will be deleted.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(remote.getByRole('row', { name: 'Open empty-prefix', exact: true })).toHaveCount(
      0,
    );
    await window.screenshot({ path: test.info().outputPath('s3-transfer.png') });
    await application.close();
    application = undefined;
    expect(
      (await readFile(join(userData, 'settings.sqlite'))).includes(
        Buffer.from('fixture-secret-only-not-production'),
      ),
    ).toBe(false);
    application = await launch();
    window = await application.firstWindow();

    await openConnection(window, 'right', 'Disposable UI MinIO');
    await expect(
      window.getByTestId('right-panel').getByRole('row', { name: 's3-renamed.txt', exact: true }),
    ).toBeVisible();
  } finally {
    await application?.close();
    await fixture.delete(createS3ProviderPath('fixture-bucket', prefix), { recursive: true });
    await fixture.disconnect();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
