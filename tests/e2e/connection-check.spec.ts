import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { newConnection } from './workspace-ui';

test('tests SFTP, FTP and S3 in the editor and returns to all connections', async () => {
  test.skip(process.env.OPENSCP_INTEGRATION !== '1', 'Requires disposable protocol fixtures.');
  test.setTimeout(90000);
  const userData = await mkdtemp(join(tmpdir(), 'openscp-profile-check-'));
  const localRoot = await mkdtemp(join(tmpdir(), 'openscp-profile-check-local-'));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
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
    const window = await application.firstWindow();
    for (const kind of ['sftp', 'ftp', 's3'] as const) {
      const form = await newConnection(window, kind);
      const name = `Check ${kind}`;
      await form.getByLabel('Profile name').fill(name);
      await expect(form.getByRole('button', { name: '← All connections' })).toBeVisible();
      if (kind === 's3') {
        await form
          .getByLabel('Endpoint (blank for AWS)', { exact: true })
          .fill('http://127.0.0.1:29000');
        await form.getByLabel('Region', { exact: true }).fill('us-east-1');
        await form
          .getByLabel('Bucket (blank to list buckets)', { exact: true })
          .fill('fixture-bucket');
        await form.getByLabel('Initial prefix').fill('prefix/');
        await form.getByLabel('Path-style addressing').check();
        await form.getByLabel('Access key ID').fill('fixture-access-only');
        await form
          .getByLabel('Secret access key', { exact: true })
          .fill('fixture-secret-only-not-production');
      } else {
        await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
        await form.getByLabel('Port', { exact: true }).fill(kind === 'sftp' ? '22222' : '21210');
        await form.getByLabel('Username', { exact: true }).fill('fixture');
        await form
          .getByLabel('Initial directory')
          .fill(kind === 'sftp' ? '/home/fixture/data' : '/data');
        await form
          .getByLabel('Password', { exact: true })
          .fill(kind === 'sftp' ? 'fixture-password-only' : 'wrong-fixture-password');
      }
      await form.getByRole('button', { name: 'Test connection', exact: true }).click();
      if (kind === 'sftp') {
        await expect(form.getByText(/Unknown server key/u)).toBeVisible();
        await expect(form.locator('.host-key code')).toHaveText(/^SHA256:/u);
        await form.getByRole('button', { name: 'Trust this key and test connection' }).click();
      } else if (kind === 'ftp') {
        await expect(
          form.getByText('Authentication failed. Check your credentials.'),
        ).toBeVisible();
        await form.getByLabel('Password', { exact: true }).fill('fixture-ftp-password-only');
        await form.getByRole('button', { name: 'Test connection', exact: true }).click();
      }
      await expect(form.getByRole('status')).toHaveText(
        'Connection successful. The initial location is accessible.',
      );
      await expect(window.getByTestId('right-panel').getByLabel('Current path')).toHaveValue(
        localRoot,
      );
      await window.screenshot({
        path: resolve(`tests/fixtures/runtime/${kind}-connection-check.png`),
      });
      await form.getByLabel('Profile name').fill(name + ' unsaved');
      await expect(form.getByRole('status')).toHaveCount(0);
      await form.getByRole('button', { name: '← All connections' }).click();
      const library = window.getByRole('dialog', { name: 'Connections', exact: true });
      await expect(library.getByRole('button', { name, exact: true })).toBeVisible();
      await expect(
        library.getByRole('button', { name: name + ' unsaved', exact: true }),
      ).toHaveCount(0);
      await library.getByRole('button', { name: `Edit: ${name}`, exact: true }).click();
      const editor = window.getByRole('dialog', { name: 'Connections', exact: true });
      await expect(editor.getByRole('button', { name: 'Test connection' })).toBeVisible();
      await editor.getByLabel('Profile name').press('Enter');
      await expect(library.getByText('Saved profiles', { exact: true })).toBeVisible();
      await library.getByRole('button', { name: 'Close', exact: true }).last().click();
    }
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
    await rm(localRoot, { recursive: true, force: true });
  }
});
