import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { copySelection, newConnection, finishProfile } from './workspace-ui';

test('local file manager, saved themes, grouped profiles and the S3 editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscp-design-files-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-design-user-'));
  let application: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
        '--no-sandbox',
        '--user-data-dir=' + userData,
        resolve('out/main/index.js'),
      ],
      env: { ...process.env, OPENSCP_LOCAL_ROOT: root, OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1' },
    });
  try {
    await mkdir(join(root, 'Archive'));
    await writeFile(join(root, 'notes.txt'), 'Local copy fixture');
    await writeFile(join(root, '.hidden'), 'Hidden fixture');
    application = await launch();
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const left = page.getByTestId('left-panel');
    const right = page.getByTestId('right-panel');
    await right.getByRole('row', { name: 'Open Archive', exact: true }).dblclick();
    await left.getByRole('row', { name: 'notes.txt', exact: true }).click();
    await copySelection(page, left);
    await expect(right.getByRole('row', { name: 'notes.txt', exact: true })).toBeVisible();
    expect(await readFile(join(root, 'Archive', 'notes.txt'), 'utf8')).toBe('Local copy fixture');
    await page.screenshot({ path: test.info().outputPath('workspace-light.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('List density').selectOption('compact');
    await page.getByRole('checkbox', { name: /Hidden files/u }).uncheck();
    await page.screenshot({ path: test.info().outputPath('settings-dark.png') });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(left.getByRole('row', { name: '.hidden', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page
      .getByRole('group', { name: 'Create connection or folder' })
      .getByRole('button', { name: 'Folder', exact: true })
      .click();
    await page.getByLabel('Folder name').fill('Team');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Team', { exact: true })).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    const form = await newConnection(page, 's3');
    await form.getByLabel('Profile name').fill('Object storage');
    await form.getByLabel('Folder', { exact: true }).selectOption('Team');
    await form.getByLabel('Bucket (blank to list buckets)').fill('design-fixture');
    await form.getByLabel('Access key ID', { exact: true }).fill('dummy-access');
    await form.getByLabel('Secret access key', { exact: true }).fill('dummy-secret-not-production');
    await expect(form.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1);
    await expect(form.getByLabel('Connection type').getByRole('option')).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath('s3-editor-dark.png') });
    await finishProfile(page, form);
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page
      .getByRole('button', { name: 'Duplicate profile: Object storage', exact: true })
      .click();
    await expect(page.getByLabel('Profile name')).toHaveValue('Object storage — Copy');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.profile-row')).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath('connections-dark.png') });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    expect(errors).toEqual([]);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('main')).toHaveAttribute('data-density', 'compact');
    await expect(
      page.getByTestId('left-panel').getByRole('row', { name: '.hidden', exact: true }),
    ).toHaveCount(0);
    await page
      .getByTestId('right-panel')
      .getByRole('button', { name: 'Drive or connection' })
      .click();
    await page.getByRole('combobox', { name: 'Search by name…' }).fill('Object storage');
    await expect(page.getByRole('option')).toHaveCount(2);
    await expect(page.getByRole('group', { name: 'Team' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('source-search-dark.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('connections-light.png') });
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
