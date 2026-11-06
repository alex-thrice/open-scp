import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { nativeKeyringLaunchOptions } from './electron-launch';
import { newConnection } from './workspace-ui';

test('offers native text editing menus and reveals only the current password draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscp-text-editing-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-text-editing-user-'));
  let application: ElectronApplication | undefined;
  try {
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
    // Playwright supplies Chromium editing commands with Meta+V itself. Checking the
    // native application menu is essential: keyboard.press alone misses the macOS regression.
    const roles = await application.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((item) => item.role?.toLowerCase() === 'editmenu')
        ?.submenu?.items.map((item) => item.role)
        .filter(Boolean),
    );
    expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']);
    const menus = await application.evaluateHandle(({ Menu }) => {
      const opened: Electron.Menu[] = [];
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        opened.push(this);
        popup.call(this, options);
      };
      return opened;
    });
    const form = await newConnection(page, 'sftp');
    const host = form.getByLabel('Host', { exact: true });
    await host.fill('server.example.test');
    await host.evaluate((input: HTMLInputElement) => input.select());
    await host.click({ button: 'right' });
    await expect
      .poll(() =>
        menus.evaluate((opened) =>
          opened.at(-1)?.items.map((item) => ({ role: item.role, label: item.label })),
        ),
      )
      .toEqual([
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
      ]);
    await menus.evaluate((opened) => opened.at(-1)?.closePopup());

    const password = form.getByLabel('Password', { exact: true });
    await password.fill('temporary-test-password');
    await expect(password).toHaveAttribute('type', 'password');
    await password.evaluate((input: HTMLInputElement) => input.select());
    await password.click({ button: 'right' });
    await expect.poll(() => menus.evaluate((opened) => opened.length)).toBe(2);
    expect(
      await menus.evaluate((opened) =>
        opened
          .at(-1)
          ?.items.slice(0, 2)
          .map((item) => item.enabled),
      ),
    ).toEqual([false, false]);
    await menus.evaluate((opened) => opened.at(-1)?.closePopup());

    await password.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 8));
    await form.getByRole('button', { name: 'Show value', exact: true }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(password).toHaveValue('temporary-test-password');
    await expect(password).toBeFocused();
    await expect
      .poll(() =>
        password.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
      )
      .toEqual([2, 8]);
    await password.click({ button: 'right' });
    await expect.poll(() => menus.evaluate((opened) => opened.length)).toBe(3);
    expect(
      await menus.evaluate((opened) =>
        opened
          .at(-1)
          ?.items.slice(0, 2)
          .map((item) => item.enabled),
      ),
    ).toEqual([true, true]);
    await menus.evaluate((opened) => opened.at(-1)?.closePopup());
    await form.getByRole('button', { name: 'Hide value', exact: true }).click();
    await expect(password).toHaveAttribute('type', 'password');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    const freshPassword = page.getByRole('dialog').getByLabel('Password', { exact: true });
    await expect(freshPassword).toHaveValue('');
    await expect(freshPassword).toHaveAttribute('type', 'password');
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
