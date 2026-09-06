import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

let electronApplication: ElectronApplication | undefined;
let fixtureRootPath: string | undefined;
let userDataPath: string | undefined;

test.afterEach(async () => {
  await electronApplication?.close();
  electronApplication = undefined;

  if (fixtureRootPath !== undefined) {
    await rm(fixtureRootPath, { force: true, recursive: true });
    fixtureRootPath = undefined;
  }

  if (userDataPath !== undefined) {
    await rm(userDataPath, { force: true, recursive: true });
    userDataPath = undefined;
  }
});

test('opens the desktop shell and changes the local directory', async () => {
  fixtureRootPath = await mkdtemp(join(tmpdir(), 'openscp-e2e-'));
  const childPath = join(fixtureRootPath, 'fixture-directory');
  await mkdir(childPath);
  await writeFile(join(fixtureRootPath, 'root-file.txt'), 'root');
  await writeFile(join(childPath, 'child-file.txt'), 'child');
  userDataPath = await mkdtemp(join(tmpdir(), 'openscp-electron-'));

  electronApplication = await electron.launch({
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
      OPENSCP_LOCAL_ROOT: fixtureRootPath,
    },
  });
  const window = await electronApplication.firstWindow();
  expect(await electronApplication.evaluate(({ app }) => app.getName())).toBe('OpenSCP');
  const localPanel = window.getByTestId('left-panel');

  await expect(window.getByRole('heading', { level: 1, name: 'OpenSCP' })).toBeVisible();
  await expect(localPanel.getByText('root-file.txt')).toBeVisible();
  await localPanel.getByRole('button', { name: 'Drive or connection' }).click();
  await expect(window.getByRole('option')).toHaveCount(1);
  await window.keyboard.press('Escape');
  await localPanel.getByRole('row', { name: 'Open fixture-directory' }).dblclick();

  await expect(localPanel.getByText('child-file.txt')).toBeVisible();
  await expect(localPanel.getByLabel('Current path')).toHaveValue(childPath);

  await window.getByRole('button', { name: 'New workspace' }).click();
  await expect(window.getByRole('tab')).toHaveCount(2);
  await expect(window.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(
    window.getByRole('tabpanel').getByTestId('right-panel').getByText('root-file.txt'),
  ).toBeVisible();
  await window.getByRole('tab').first().click();
  await expect(
    window.getByRole('tabpanel').getByTestId('left-panel').getByText('child-file.txt'),
  ).toBeVisible();
  await window.screenshot({ path: test.info().outputPath('drive-selector.png') });
});

test('discovers Windows drives and opens the drive root from the selector', async () => {
  test.skip(process.platform !== 'win32', 'Windows drive-letter integration check.');
  userDataPath = await mkdtemp(join(tmpdir(), 'openscp-electron-'));
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'OPENSCP_LOCAL_ROOT') {
      environment[key] = value;
    }
  }

  environment.OPENSCP_DISABLE_HARDWARE_ACCELERATION = '1';
  electronApplication = await electron.launch({
    args: [
      '--disable-gpu',
      '--in-process-gpu',
      '--no-sandbox',
      `--user-data-dir=${userDataPath}`,
      resolve('out/main/index.js'),
    ],
    env: environment,
  });
  const window = await electronApplication.firstWindow();
  const localPanel = window.getByTestId('left-panel');
  const driveSelector = localPanel.getByRole('button', { name: 'Drive or connection' });
  const rootPath = parse(homedir()).root;

  await expect(localPanel.getByLabel('Current path')).toBeVisible();
  await expect(driveSelector).toContainText(rootPath);
  await driveSelector.click();
  await window.getByRole('combobox', { name: 'Search by name…' }).fill(rootPath);
  await window.getByRole('option').first().click();
  await expect(localPanel.getByRole('button', { name: 'Go to parent directory' })).toBeDisabled();
  await expect(localPanel.getByLabel('Current path')).toHaveValue(rootPath);
  await expect(driveSelector.locator('img')).toHaveCount(1);
  await expect(localPanel.getByRole('alert')).toHaveCount(0);
});
