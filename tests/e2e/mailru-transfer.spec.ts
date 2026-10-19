import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { fixtureMailruPassword, startWebDavFixture } from '../fixtures/webdav-fixture';
import { copySelection, finishProfile, newConnection, openConnection } from './workspace-ui';
import { nativeKeyringLaunchOptions } from './electron-launch';

test('Mail.ru profile, password correction, shared queue, reconnect and secure persistence', async () => {
  test.setTimeout(90000);
  const fixture = await startWebDavFixture();
  const localRoot = await mkdtemp(join(tmpdir(), 'openscp-mailru-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-mailru-user-'));
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
        OPENSCP_WEBDAV_FIXTURE: '1',
        OPENSCP_TEST_MAILRU_ENDPOINT: fixture.endpoint,
      },
    });
  try {
    await mkdir(join(localRoot, 'downloads'));
    await writeFile(join(localRoot, 'mailru-upload.txt'), 'Disposable WebDAV UI content.');
    application = await launch();
    let window = await application.firstWindow();
    const form = await newConnection(window, 'mailru');
    await expect(form.getByLabel('Host', { exact: true })).toHaveCount(0);
    await form.getByLabel('Profile name').fill('Disposable Mail.ru');
    await form.getByLabel('Mail account email').fill('fixture@example.test');
    const passwordHelp = form.getByRole('button', { name: 'How to create a Mail.ru app password' });
    const passwordHint = form.getByRole('tooltip', { includeHidden: true });
    await expect(passwordHint).toBeHidden();
    await passwordHelp.hover();
    await expect(passwordHint).toBeVisible();
    await expect(passwordHint).toContainText('Full access to Cloud');
    await expect(passwordHint).toContainText('Regular and VK ID passwords do not work');
    await form.getByLabel('Profile name').hover();
    await expect(passwordHint).toBeHidden();
    await passwordHelp.click();
    await form.getByLabel('Profile name').hover();
    await expect(passwordHint).toBeVisible();
    await window.screenshot({ path: resolve('tests/fixtures/runtime/mailru-password-hint.png') });
    await window.keyboard.press('Escape');
    await expect(passwordHint).toBeHidden();
    await expect(form).toBeVisible();
    await passwordHelp.focus();
    await window.keyboard.press('Enter');
    await expect(passwordHint).toBeVisible();
    await passwordHelp.click();
    await expect(passwordHint).toBeHidden();
    await passwordHelp.click();
    await form.getByLabel('Mail account email').click();
    await expect(passwordHint).toBeHidden();
    await window.screenshot({ path: resolve('tests/fixtures/runtime/mailru-password-form.png') });
    fixture.overrides.set('PROPFIND /', { status: 403 });
    await form.getByLabel('App password', { exact: true }).fill(fixtureMailruPassword);
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Mail.ru denied WebDAV access.');
    await expect(form.getByRole('alert')).toContainText('Full access to Cloud');
    const failureNotice = form.locator('.dialog-notice .connection-feedback--error');
    await expect(failureNotice).toBeVisible();
    await expect(failureNotice).toHaveCSS('background-color', 'rgb(255, 241, 242)');
    await expect(form.locator('.dialog-body').getByRole('alert')).toHaveCount(0);
    await window.screenshot({ path: resolve('tests/fixtures/runtime/mailru-check-failure.png') });
    await expect(form.getByLabel('App password', { exact: true })).toHaveValue('');
    await window.screenshot({ path: resolve('tests/fixtures/runtime/mailru-login-help.png') });
    fixture.overrides.clear();
    await form.getByLabel('App password', { exact: true }).fill(fixtureMailruPassword);
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.getByRole('status')).toHaveText(
      'Connection successful. The initial location is accessible.',
    );
    const successNotice = form.locator('.dialog-notice .connection-feedback--success');
    await expect(successNotice).toBeVisible();
    await expect(successNotice).toHaveCSS('background-color', 'rgb(237, 248, 239)');
    await expect(form.locator('.dialog-body').getByRole('status')).toHaveCount(0);
    await form.getByText('Advanced', { exact: true }).click();
    await form.locator('.dialog-body').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(successNotice).toBeVisible();
    const [bodyBounds, noticeBounds, footerBounds] = await Promise.all([
      form.locator('.dialog-body').boundingBox(),
      form.locator('.dialog-notice').boundingBox(),
      form.locator('.dialog-footer').boundingBox(),
    ]);
    if (!bodyBounds || !noticeBounds || !footerBounds) throw new Error('Dialog bounds missing.');
    expect(noticeBounds.y).toBeGreaterThanOrEqual(bodyBounds.y + bodyBounds.height - 1);
    expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(footerBounds.y + 1);
    await window.screenshot({ path: resolve('tests/fixtures/runtime/mailru-check-success.png') });
    await expect(form.getByLabel('App password', { exact: true })).toHaveValue('');
    await finishProfile(window, form);
    await window.getByRole('button', { name: 'Connections', exact: true }).click();
    await window.getByRole('button', { name: 'Edit: Disposable Mail.ru', exact: true }).click();
    await form.getByRole('button', { name: '← All connections', exact: true }).click();
    await expect(
      window
        .getByRole('dialog', { name: 'Connections', exact: true })
        .getByText('Saved profiles', { exact: true }),
    ).toBeVisible();
    await window
      .getByRole('dialog', { name: 'Connections', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    fixture.overrides.set('PROPFIND /', { status: 403 });
    await openConnection(window, 'right', 'Disposable Mail.ru');
    const passwordDialog = window.getByRole('dialog', { name: 'Connection password' });
    await expect(passwordDialog).toBeVisible();
    await expect(passwordDialog.getByText(/^Mail.ru denied WebDAV access\./u)).toBeVisible();
    await expect(passwordDialog.getByRole('tooltip', { includeHidden: true })).toBeHidden();
    await passwordDialog
      .getByRole('button', { name: 'How to create a Mail.ru app password' })
      .click();
    await expect(passwordDialog.getByRole('tooltip')).toContainText('Full access to Cloud');
    await window.keyboard.press('Escape');
    await expect(passwordDialog.getByRole('tooltip', { includeHidden: true })).toBeHidden();
    await passwordDialog.getByLabel('App password', { exact: true }).fill('wrong-fixture');
    await passwordDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      passwordDialog.getByText('Authentication failed. Check your credentials.'),
    ).toBeVisible();
    fixture.overrides.clear();
    await passwordDialog.getByLabel('App password', { exact: true }).fill(fixtureMailruPassword);
    await passwordDialog.getByLabel('Save password in secure system storage').check();
    await passwordDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(passwordDialog).toHaveCount(0);
    const remote = window.getByTestId('right-panel');
    const local = window.getByTestId('left-panel');
    await expect(remote.getByLabel('Current path')).toHaveValue('/');
    await local.getByRole('row', { name: 'mailru-upload.txt', exact: true }).click();
    await copySelection(window, local);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(1);
    expect(fixture.entries.get('/mailru-upload.txt')?.content.toString()).toBe(
      'Disposable WebDAV UI content.',
    );
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await remote.getByRole('row', { name: 'mailru-upload.txt', exact: true }).click();
    await local.getByRole('row', { name: 'Open downloads' }).dblclick();
    await copySelection(window, remote);
    await expect(window.getByText(/^Completed ·/u)).toHaveCount(2);
    expect(await readFile(join(localRoot, 'downloads', 'mailru-upload.txt'), 'utf8')).toBe(
      'Disposable WebDAV UI content.',
    );
    await window.screenshot({ path: resolve('tests/fixtures/runtime/mailru-ui.png') });
    await application.close();
    application = undefined;
    expect(
      (await readFile(join(userData, 'settings.sqlite'))).includes(
        Buffer.from(fixtureMailruPassword),
      ),
    ).toBe(false);
    application = await launch();
    window = await application.firstWindow();
    await openConnection(window, 'right', 'Disposable Mail.ru');
    await expect(window.getByTestId('right-panel').getByLabel('Current path')).toHaveValue('/');
    await expect(window.getByRole('dialog', { name: 'Connection password' })).toHaveCount(0);
  } finally {
    await application?.close();
    await fixture.close();
    await rm(localRoot, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
