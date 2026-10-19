import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { nativeKeyringLaunchOptions } from './electron-launch';
import { finishProfile, newConnection } from './workspace-ui';

test('panel navigation, modal focus, confirmation, cancellation and connection drafts', async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), 'openscp-dialogs-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-dialogs-user-'));
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(root, 'Destination'));
    await writeFile(join(root, 'notes.txt'), 'Modal copy content');
    application = await electron.launch({
      ...nativeKeyringLaunchOptions(),
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        '--no-sandbox',
        `--user-data-dir=${userData}`,
        resolve('out/main/index.js'),
      ],
      env: { ...process.env, OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1', OPENSCP_LOCAL_ROOT: root },
    });
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const left = page.getByTestId('left-panel');
    const right = page.getByTestId('right-panel');
    const source = left.getByRole('row', { name: 'notes.txt', exact: true });
    await source.click();
    await page.keyboard.press('Tab');
    await expect(right.locator('[data-testid="file-row"]:focus')).toHaveCount(1);
    await page.keyboard.press('Shift+Tab');
    await expect(left.locator('[data-testid="file-row"]:focus')).toHaveCount(1);
    await right.getByRole('row', { name: 'Open Destination', exact: true }).dblclick();
    await source.focus();
    await page.keyboard.press('Tab');
    await expect(right.locator('.commander-surface')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('F5');
    const copying = page.getByRole('dialog', { name: 'Copy', exact: true });
    await expect(copying.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('copy-confirmation.png') });
    await page.keyboard.press('Escape');
    await expect(copying).toHaveCount(0);
    await expect(source).toBeFocused();
    await expect(stat(join(root, 'Destination', 'notes.txt'))).rejects.toThrow();
    await page.keyboard.press('F5');
    await expect(copying).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(copying).toHaveCount(0);
    await expect(right.getByRole('row', { name: 'notes.txt', exact: true })).toBeVisible();
    expect(await readFile(join(root, 'Destination', 'notes.txt'), 'utf8')).toBe(
      'Modal copy content',
    );

    await source.focus();
    await page.keyboard.press('F7');
    const directory = page.getByRole('dialog', { name: 'New directory', exact: true });
    await expect(directory.getByLabel('Name', { exact: true })).toBeFocused();
    await directory.getByLabel('Name', { exact: true }).fill('Canceled folder');
    await page.keyboard.press('Escape');
    await expect(stat(join(root, 'Canceled folder'))).rejects.toThrow();
    await left.getByRole('button', { name: 'New file', exact: true }).click();
    const creating = page.getByRole('dialog', { name: 'New file', exact: true });
    await expect(creating.getByLabel('Name', { exact: true })).toBeFocused();
    await creating.getByLabel('Name', { exact: true }).fill('created.txt');
    await page.keyboard.press('Enter');
    const created = left.getByRole('row', { name: 'created.txt', exact: true });
    await created.click();
    await page.keyboard.press('Delete');
    const deleting = page.getByRole('dialog', { name: 'Delete', exact: true });
    await expect(deleting.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('');
    await created.focus();
    await page.keyboard.press('Delete');
    await expect(deleting).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(created).toHaveCount(0);

    const originalTheme = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.getByLabel('Language', { exact: true }).selectOption('ru');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', originalTheme ?? 'light');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    let form = await newConnection(page, 's3');
    await expect(form.getByLabel('Profile name')).toBeFocused();
    await form.getByLabel('Profile name').fill('Preserved name');
    for (const kind of ['ftp', 'mailru', 'yandex', 'google', 'sftp']) {
      await page.getByLabel('Connection type').selectOption(kind);
      form = page.getByRole('dialog');
      await expect(form.getByLabel('Profile name')).toHaveValue('Preserved name');
    }
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await form.getByText('Advanced', { exact: true }).click();
    await form.getByLabel('Port', { exact: true }).fill('1');
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.locator('.dialog-notice .connection-feedback--error')).toBeVisible();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.profile-row')).toHaveCount(0);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();

    form = await newConnection(page, 'sftp');
    await form.getByLabel('Authentication').selectOption('agent');
    await form.getByLabel('Profile name').fill('Saved connection');
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await finishProfile(page, form);
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Edit: Saved connection', exact: true }).click();
    form = page.getByRole('dialog');
    await form.getByLabel('Profile name').fill('Unsaved connection');
    await form.getByText('Advanced', { exact: true }).click();
    await form.getByLabel('Port', { exact: true }).fill('1');
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.locator('.dialog-notice .connection-feedback--error')).toBeVisible();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Delete profile: Saved connection', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Delete profile: Unsaved connection', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Delete profile: Saved connection', exact: true })
      .click();
    const remove = page.getByRole('dialog', { name: 'Delete profile', exact: true });
    await expect(remove.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('profile-delete-confirmation.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('.profile-row')).toHaveCount(1);
    await page
      .getByRole('button', { name: 'Delete profile: Saved connection', exact: true })
      .click();
    await expect(remove).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(remove).toHaveCount(0);
    await expect(page.locator('.profile-row')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
