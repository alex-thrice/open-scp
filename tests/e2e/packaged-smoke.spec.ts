import { newConnection, finishProfile, openConnection } from './workspace-ui';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { DesktopApi } from '../../src/shared/desktop-api';
import { formatS3Path } from '../../src/shared/models/s3-path';
import { createS3ProviderPath } from '../../src/shared/models/provider-path';
import type { WorkspaceRequest } from '../../src/shared/ipc/workspace';

const launchArguments = (userData: string): string[] => [
  '--disable-gpu',
  '--in-process-gpu',
  `--user-data-dir=${userData}`,
  ...(process.env.OPENSCP_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
  ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
];

const request = async (page: Page, operation: WorkspaceRequest) => {
  const response = await page.evaluate(async (operation) => {
    const api = Reflect.get(globalThis, 'desktop') as DesktopApi;
    return api.workspace(operation);
  }, operation);
  if (!response.ok) throw new Error(response.error.code);
  return response.data;
};

const roundTrip = async (page: Page, userData: string, kind: 'sftp' | 's3') => {
  const name = `packaged-${randomUUID()}-Юникод.txt`;
  const source = join(userData, name);
  const content = 'Installed package roundtrip: Юникод\n';
  await writeFile(source, content);
  const directory = join(userData, `${kind}-downloads`);
  await mkdir(directory, { recursive: true });
  const remoteDirectory =
    kind === 'sftp'
      ? '/home/fixture/data'
      : formatS3Path(createS3ProviderPath('fixture-bucket', 'prefix/'));
  const remotePath =
    kind === 'sftp'
      ? `${remoteDirectory}/${name}`
      : formatS3Path(createS3ProviderPath('fixture-bucket', `prefix/${name}`));
  const workspaceId = 'workspace-1:right';
  let completed = await page.getByText(/^Completed ·/u).count();
  try {
    await request(page, {
      action: 'transfer',
      workspaceId,
      direction: 'upload',
      sourcePath: source,
      destinationDirectory: remoteDirectory,
      conflictPolicy: 'fail',
    });
    await expect(page.getByText(/^Completed ·/u)).toHaveCount(++completed);
    await request(page, {
      action: 'transfer',
      workspaceId,
      direction: 'download',
      sourcePath: remotePath,
      destinationDirectory: directory,
      conflictPolicy: 'fail',
    });
    await expect(page.getByText(/^Completed ·/u)).toHaveCount(++completed);
    expect(await readFile(join(directory, name), 'utf8')).toBe(content);
  } finally {
    if (kind === 's3') {
      const preview = await request(page, {
        action: 'preview-delete',
        workspaceId,
        path: remotePath,
      });
      await request(page, {
        action: 'delete',
        workspaceId,
        path: remotePath,
        recursive: false,
        confirmationId: preview.deletion?.confirmationId,
      });
    } else
      await request(page, { action: 'delete', workspaceId, path: remotePath, recursive: false });
  }
};

test('packaged application starts with secure IPC and encrypted profile persistence', async () => {
  test.setTimeout(120000);
  const executablePath = process.env.OPENSCP_PACKAGED_EXE;
  test.skip(executablePath === undefined, 'Requires an explicitly selected packaged executable.');
  if (executablePath === undefined) return;
  const userData = await mkdtemp(join(tmpdir(), 'openscp packaged Юникод-'));
  const integration = process.env.OPENSCP_INTEGRATION === '1';
  let application: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      executablePath,
      args: launchArguments(userData),
      env: { ...process.env, OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1' },
    });
  try {
    application = await launch();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const applicationVersion = await application.evaluate(({ app }) => app.getVersion());
    expect(await application.evaluate(({ app }) => app.getName())).toBe(
      process.env.APP_PRODUCT_NAME ?? 'OpenSCP',
    );
    const resourcesPath = await application.evaluate(() => process.resourcesPath);
    expect(await readFile(join(resourcesPath, 'LICENSE'), 'utf8')).toContain('MIT License');
    for (const file of [
      'THIRD_PARTY_NOTICES.md',
      'licenses/DEPENDENCIES.txt',
      'licenses/dependencies.json',
      'licenses/LICENSE.electron',
      'licenses/LICENSES.chromium.html',
    ])
      expect((await stat(join(resourcesPath, file))).size).toBeGreaterThan(0);
    const canary = await application.evaluate(({ safeStorage }) =>
      safeStorage.encryptString('packaged-keyring-restart-canary').toString('base64'),
    );
    const storage = await application.evaluate(({ safeStorage }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system',
    }));
    expect(storage.available).toBe(true);
    expect(['system', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']).toContain(
      storage.backend,
    );
    let window = await application.firstWindow();
    await expect(window.getByTestId('left-panel').getByLabel('Current path')).toBeVisible();
    await expect(window.getByTestId('right-panel')).toBeVisible();
    const updateState = (await request(window, { action: 'snapshot' })).snapshot.updateState;
    expect(updateState).toMatchObject({
      supported: true,
      currentVersion: applicationVersion,
    });
    if (process.platform === 'darwin')
      expect(updateState?.automaticUpdateSupported).toBe(process.env.OPENSCP_SIGNED_BUILD === '1');
    expect(await window.evaluate(() => 'require' in window || 'process' in window)).toBe(false);
    const form = await newConnection(window, 'sftp');
    await form.getByLabel('Profile name').fill('Disposable packaged profile');
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    const password = integration ? 'fixture-password-only' : 'packaged-smoke-dummy-password-only';
    await form.getByLabel('Password', { exact: true }).fill(password);
    if (integration) {
      await form.getByLabel('Port', { exact: true }).fill('22222');
      await form.getByLabel('Initial directory').fill('/home/fixture/data');
    }
    await finishProfile(window, form);
    await application.close();
    application = undefined;
    expect(
      (await readFile(join(userData, 'settings.sqlite'))).includes(Buffer.from(password)),
    ).toBe(false);
    application = await launch();
    expect(
      await application.evaluate(
        ({ safeStorage }, canary) => safeStorage.decryptString(Buffer.from(canary, 'base64')),
        canary,
      ),
    ).toBe('packaged-keyring-restart-canary');
    window = await application.firstWindow();
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Disposable packaged profile', exact: true }),
    ).toBeVisible();
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    if (integration) {
      await openConnection(window, 'right', 'Disposable packaged profile');
      await window.getByRole('button', { name: 'Trust this key and connect' }).click();
      await expect(window.getByTestId('right-panel').getByLabel('Current path')).toHaveValue(
        '/home/fixture/data',
      );
      await roundTrip(window, userData, 'sftp');
      await request(window, { action: 'disconnect', workspaceId: 'workspace-1:right' });
      const s3Form = await newConnection(window, 's3');
      await s3Form.getByLabel('Profile name').fill('Packaged MinIO');
      await s3Form.getByLabel('Endpoint (blank for AWS)').fill('http://127.0.0.1:29000');
      await s3Form.getByLabel('Bucket (blank to list buckets)').fill('fixture-bucket');
      await s3Form.getByLabel('Initial prefix').fill('prefix/');
      await s3Form.getByLabel('Path-style addressing').check();
      await s3Form.getByLabel('Access key ID', { exact: true }).fill('fixture-access-only');
      await s3Form
        .getByLabel('Secret access key', { exact: true })
        .fill('fixture-secret-only-not-production');
      await finishProfile(window, s3Form);
      await openConnection(window, 'right', 'Packaged MinIO');
      await expect(
        window
          .getByTestId('right-panel')
          .getByRole('row', { name: 'Unicode ключ.txt', exact: true }),
      ).toBeVisible();
      const destinationDirectory = join(userData, 'downloads');
      await mkdir(destinationDirectory);
      await window.evaluate(
        async ({ destinationDirectory, sourcePath }) => {
          const api = Reflect.get(window, 'desktop') as DesktopApi;
          const response = await api.workspace({ action: 'snapshot' });
          if (!response.ok) throw new Error('Snapshot failed.');
          const workspaceId = response.data.snapshot.sessions[0]?.workspaceId;
          if (!workspaceId) throw new Error('No packaged session.');
          const transfer = await api.workspace({
            action: 'transfer',
            workspaceId,
            direction: 'download',
            sourcePath,
            destinationDirectory,
            conflictPolicy: 'fail',
          });
          if (!transfer.ok) throw new Error(transfer.error.code);
        },
        {
          destinationDirectory,
          sourcePath: formatS3Path(
            createS3ProviderPath('fixture-bucket', 'prefix/Unicode ключ.txt'),
          ),
        },
      );
      await expect(window.getByText(/^Completed ·/u)).toHaveCount(3);
      expect(await readFile(join(destinationDirectory, 'Unicode ключ.txt'), 'utf8')).toBe(
        'fixture object\n',
      );
      await roundTrip(window, userData, 's3');
      await application.close();
      application = undefined;
      expect(
        (await readFile(join(userData, 'settings.sqlite'))).includes(
          Buffer.from('fixture-secret-only-not-production'),
        ),
      ).toBe(false);
      application = await launch();
      window = await application.firstWindow();
      // Both passwords must actually decrypt after restart, not just list profile metadata.
      for (const label of ['Packaged MinIO', 'Disposable packaged profile']) {
        await openConnection(window, 'right', label);
        await expect(window.getByTestId('right-panel').getByLabel('Current path')).toHaveValue(
          label === 'Packaged MinIO'
            ? formatS3Path(createS3ProviderPath('fixture-bucket', 'prefix/'))
            : '/home/fixture/data',
        );
        await expect(
          window.getByRole('button', { name: 'Trust this key and connect' }),
        ).toHaveCount(0);
        await request(window, { action: 'disconnect', workspaceId: 'workspace-1:right' });
      }
    }
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('packaged Linux refuses the real basic_text backend without writing a profile', async () => {
  const executablePath = process.env.OPENSCP_PACKAGED_EXE;
  test.skip(
    process.platform !== 'linux' || !executablePath,
    'Requires a packaged Linux executable.',
  );
  if (!executablePath) return;
  const userData = await mkdtemp(join(tmpdir(), 'openscp-insecure-store-'));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath,
      args: [
        ...launchArguments(userData).filter(
          (argument) => !argument.startsWith('--password-store='),
        ),
        '--password-store=basic',
      ],
    });
    expect(
      await application.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend()),
    ).toBe('basic_text');
    const page = await application.firstWindow();
    const form = await newConnection(page, 'sftp');
    await form.getByLabel('Profile name').fill('Must not persist');
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await form.getByLabel('Password', { exact: true }).fill('insecure-fixture-secret');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(
      form.getByText('Secure system storage is unavailable. Saving secrets is disabled.'),
    ).toBeVisible();
    expect((await request(page, { action: 'snapshot' })).snapshot.profiles).toHaveLength(0);
    await application.close();
    application = undefined;
    expect(
      (await readFile(join(userData, 'settings.sqlite'))).includes(
        Buffer.from('insecure-fixture-secret'),
      ),
    ).toBe(false);
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
