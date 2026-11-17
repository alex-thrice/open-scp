import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { nativeKeyringLaunchOptions } from './electron-launch';

let application: ElectronApplication | undefined;
let fixtureRoot: string;
let userDataPath: string;

test.beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'openscp-local-watch-'));
  userDataPath = await mkdtemp(join(tmpdir(), 'openscp-local-watch-user-'));
});

test.afterEach(async () => {
  await application?.close();
  application = undefined;
  await rm(fixtureRoot, { force: true, recursive: true });
  await rm(userDataPath, { force: true, recursive: true });
});

const openApplication = async () => {
  application = await electron.launch({
    ...nativeKeyringLaunchOptions(),
    args: [
      '--disable-gpu',
      '--in-process-gpu',
      '--no-sandbox',
      `--user-data-dir=${userDataPath}`,
      resolve('out/main/index.js'),
    ],
    env: {
      ...process.env,
      OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
      OPENSCP_LOCAL_ROOT: fixtureRoot,
    },
  });
  return application.firstWindow();
};

test('updates both local panels after external changes and keeps selection and keyboard focus', async () => {
  await writeFile(join(fixtureRoot, 'selected.txt'), 'selected');
  const page = await openApplication();
  const left = page.getByTestId('left-panel');
  const right = page.getByTestId('right-panel');
  const selected = left.getByRole('row', { name: 'selected.txt', exact: true });
  await expect(right.getByRole('row', { name: 'selected.txt', exact: true })).toBeVisible();
  await selected.click();

  const createdPath = join(fixtureRoot, 'external.txt');
  const renamedPath = join(fixtureRoot, 'renamed.txt');
  await writeFile(createdPath, 'new');
  for (const panel of [left, right])
    await expect(panel.getByRole('row', { name: 'external.txt', exact: true })).toBeVisible();
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toBeFocused();

  await writeFile(createdPath, 'x'.repeat(2048));
  for (const panel of [left, right])
    await expect(
      panel
        .getByRole('row', { name: 'external.txt', exact: true })
        .locator('.file-list__cell--size'),
    ).toHaveText('2 kB');
  await expect(selected).toBeFocused();

  await rename(createdPath, renamedPath);
  for (const panel of [left, right]) {
    await expect(panel.getByRole('row', { name: 'external.txt', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('row', { name: 'renamed.txt', exact: true })).toBeVisible();
  }
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toBeFocused();

  await rm(renamedPath);
  for (const panel of [left, right])
    await expect(panel.getByRole('row', { name: 'renamed.txt', exact: true })).toHaveCount(0);
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toBeFocused();
});

test('refreshes hidden workspaces when activated and ignores changes from the previous directory', async () => {
  const firstPath = join(fixtureRoot, 'first');
  const secondPath = join(fixtureRoot, 'second');
  await mkdir(firstPath);
  await mkdir(secondPath);
  await writeFile(join(firstPath, 'first.txt'), 'first');
  await writeFile(join(secondPath, 'second.txt'), 'second');
  const page = await openApplication();
  const activeLeft = () => page.getByRole('tabpanel').getByTestId('left-panel');
  await activeLeft().getByRole('row', { name: 'Open first', exact: true }).dblclick();
  await expect(activeLeft().getByLabel('Current path')).toHaveValue(firstPath);

  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await activeLeft().getByLabel('Current path').fill(fixtureRoot);
  await page.keyboard.press('Enter');
  await expect(activeLeft().getByLabel('Current path')).toHaveValue(fixtureRoot);
  await writeFile(join(firstPath, 'while-hidden.txt'), 'hidden update');
  await page.getByRole('tab').first().click();
  await expect(
    activeLeft().getByRole('row', { name: 'while-hidden.txt', exact: true }),
  ).toBeVisible();

  await activeLeft().getByLabel('Current path').fill(secondPath);
  await page.keyboard.press('Enter');
  await expect(activeLeft().getByRole('row', { name: 'second.txt', exact: true })).toBeVisible();
  await writeFile(join(firstPath, 'old-directory-event.txt'), 'previous directory');
  await writeFile(join(secondPath, 'current-directory-event.txt'), 'current directory');
  await expect(
    activeLeft().getByRole('row', { name: 'current-directory-event.txt', exact: true }),
  ).toBeVisible();
  await expect(activeLeft().getByLabel('Current path')).toHaveValue(secondPath);
  await expect(
    activeLeft().getByRole('row', { name: 'old-directory-event.txt', exact: true }),
  ).toHaveCount(0);
  await expect(activeLeft().getByRole('row', { name: 'first.txt', exact: true })).toHaveCount(0);
});

test('defers background updates while a file operation dialog is open and keeps its draft', async () => {
  await writeFile(join(fixtureRoot, 'existing.txt'), 'existing');
  const page = await openApplication();
  const left = page.getByTestId('left-panel');
  const right = page.getByTestId('right-panel');
  await expect(left.getByRole('row', { name: 'existing.txt', exact: true })).toBeVisible();
  await left.getByRole('button', { name: 'New file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New file', exact: true });
  const name = dialog.getByLabel('Name', { exact: true });
  await name.fill('unfinished-draft.txt');

  await writeFile(join(fixtureRoot, 'during-dialog.txt'), 'external creation');
  await expect(
    right.getByTestId('file-row').filter({ hasText: 'during-dialog.txt' }),
  ).toBeVisible();
  await expect(left.getByTestId('file-row').filter({ hasText: 'during-dialog.txt' })).toHaveCount(
    0,
  );
  await expect(name).toHaveValue('unfinished-draft.txt');
  await expect(name).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(left.getByRole('row', { name: 'during-dialog.txt', exact: true })).toBeVisible();
});

test('clears stale files when the current directory disappears and recovers after recreation', async () => {
  const directoryPath = join(fixtureRoot, 'watched-directory');
  await mkdir(directoryPath);
  await writeFile(join(directoryPath, 'original.txt'), 'original content');
  const page = await openApplication();
  const left = page.getByTestId('left-panel');
  await left.getByRole('row', { name: 'Open watched-directory', exact: true }).dblclick();
  await expect(left.getByRole('row', { name: 'original.txt', exact: true })).toBeVisible();

  await writeFile(join(directoryPath, 'before-removal.txt'), 'watcher is active');
  await expect(left.getByRole('row', { name: 'before-removal.txt', exact: true })).toBeVisible();
  await rm(directoryPath, { recursive: true });
  await expect(left.getByRole('alert')).toBeVisible();
  await expect(left.getByRole('row', { name: 'original.txt', exact: true })).toHaveCount(0);
  await expect(left.getByRole('row', { name: 'before-removal.txt', exact: true })).toHaveCount(0);
  await expect(left.getByLabel('Current path')).toHaveValue(directoryPath);

  await mkdir(directoryPath);
  await writeFile(join(directoryPath, 'recreated.txt'), 'new directory content');
  await expect(left.getByRole('row', { name: 'recreated.txt', exact: true })).toBeVisible();
  await expect(left.getByRole('alert')).toHaveCount(0);
  await expect(left.getByRole('row', { name: 'original.txt', exact: true })).toHaveCount(0);
  await expect(left.getByLabel('Current path')).toHaveValue(directoryPath);
});
