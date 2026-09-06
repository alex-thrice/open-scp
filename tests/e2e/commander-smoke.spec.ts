import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { DesktopApi } from '../../src/shared/desktop-api';

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
  await expect(localPanel.getByRole('row', { name: 'root-file.txt' })).toBeVisible();
  await localPanel.getByRole('button', { name: 'Drive or connection' }).click();
  await expect(window.getByRole('option')).toHaveCount(1);
  await window.keyboard.press('Escape');
  await localPanel.getByRole('row', { name: 'Open fixture-directory' }).dblclick();

  await expect(localPanel.getByRole('row', { name: 'child-file.txt' })).toBeVisible();
  await expect(localPanel.getByLabel('Current path')).toHaveValue(childPath);

  await window.getByRole('button', { name: 'New workspace' }).click();
  await expect(window.getByRole('tab')).toHaveCount(2);
  await expect(window.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(
    window
      .getByRole('tabpanel')
      .getByTestId('right-panel')
      .getByRole('row', { name: 'root-file.txt' }),
  ).toBeVisible();
  await window.getByRole('tab').first().click();
  await expect(
    window
      .getByRole('tabpanel')
      .getByTestId('left-panel')
      .getByRole('row', { name: 'child-file.txt' }),
  ).toBeVisible();
  await window.screenshot({ path: test.info().outputPath('drive-selector.png') });
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const desktop = (globalThis as typeof globalThis & { desktop: DesktopApi }).desktop;
        const result = await desktop.workspace({ action: 'snapshot' });
        return result.ok ? result.data.snapshot.localPaths?.['workspace-1:left'] : undefined;
      }),
    )
    .toBe(childPath);

  await electronApplication.close();
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
  const restoredWindow = await electronApplication.firstWindow();
  await expect(restoredWindow.getByRole('tab')).toHaveCount(2);
  const restoredLeftPanel = restoredWindow.getByRole('tabpanel').getByTestId('left-panel');
  await expect(restoredLeftPanel.getByLabel('Current path')).toHaveValue(childPath);
  await expect(restoredLeftPanel.getByRole('row', { name: 'child-file.txt' })).toBeVisible();
});

test('discovers Windows drives and reopens the most recent drive path', async () => {
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
  const recentPath = homedir();

  await expect(localPanel.getByLabel('Current path')).toBeVisible();
  await expect(driveSelector).toContainText(rootPath);
  await driveSelector.click();
  await window.getByRole('combobox', { name: 'Search by name…' }).fill(rootPath);
  await window.getByRole('option').first().click();
  await expect(localPanel.getByRole('button', { name: 'Go to parent directory' })).toBeEnabled();
  await expect(localPanel.getByLabel('Current path')).toHaveValue(recentPath);
  await expect(driveSelector.locator('img')).toHaveCount(1);
  await expect(localPanel.getByRole('alert')).toHaveCount(0);
});

test('restores the maximized main window and its normal bounds', async () => {
  test.skip(process.platform !== 'win32', 'Windows window-state integration check.');
  const localRootPath = await mkdtemp(join(tmpdir(), 'openscp-e2e-window-'));
  const currentUserDataPath = await mkdtemp(join(tmpdir(), 'openscp-electron-'));
  fixtureRootPath = localRootPath;
  userDataPath = currentUserDataPath;
  const launchApplication = (): Promise<ElectronApplication> =>
    electron.launch({
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        '--no-sandbox',
        `--user-data-dir=${currentUserDataPath}`,
        resolve('out/main/index.js'),
      ],
      env: {
        ...process.env,
        OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
        OPENSCP_LOCAL_ROOT: localRootPath,
      },
    });

  electronApplication = await launchApplication();
  const initialWindow = await electronApplication.firstWindow();
  await expect(initialWindow.getByRole('heading', { level: 1, name: 'OpenSCP' })).toBeVisible();
  const savedBounds = await electronApplication.evaluate(({ BrowserWindow, screen }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(980, workArea.width);
    const height = Math.min(640, workArea.height);
    mainWindow?.setBounds({
      x: workArea.x + Math.min(80, workArea.width - width),
      y: workArea.y + Math.min(70, workArea.height - height),
      width,
      height,
    });
    const bounds = mainWindow?.getNormalBounds();
    mainWindow?.maximize();
    return bounds;
  });
  await expect
    .poll(() =>
      electronApplication?.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false,
      ),
    )
    .toBe(true);

  await electronApplication.close();
  electronApplication = await launchApplication();
  await electronApplication.firstWindow();

  await expect
    .poll(() =>
      electronApplication?.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false,
      ),
    )
    .toBe(true);
  expect(
    await electronApplication.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getNormalBounds(),
    ),
  ).toEqual(savedBounds);
});

test('searches incrementally in either active file pane', async () => {
  fixtureRootPath = await mkdtemp(join(tmpdir(), 'openscp-e2e-search-'));
  await writeFile(join(fixtureRootPath, 'alpha-one.txt'), 'one');
  await writeFile(join(fixtureRootPath, 'alpha-two.txt'), 'two');
  await writeFile(join(fixtureRootPath, 'beta.txt'), 'beta');
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
  await electronApplication.evaluate(({ shell }) => {
    const mainProcessState = globalThis as typeof globalThis & {
      __openscpOpenedPaths?: string[];
    };
    mainProcessState.__openscpOpenedPaths = [];
    Object.defineProperty(shell, 'openPath', {
      configurable: true,
      value: async (path: string) => {
        mainProcessState.__openscpOpenedPaths?.push(path);
        return '';
      },
    });
  });
  const leftPanel = window.getByTestId('left-panel');
  const rightPanel = window.getByTestId('right-panel');

  await leftPanel.getByRole('row', { name: 'alpha-one.txt' }).click();
  await window.keyboard.type('alpha');
  const leftSearch = leftPanel.getByRole('searchbox', { name: 'Search files and folders' });
  await expect(leftSearch).toHaveValue('alpha');
  await expect(leftPanel.getByRole('status')).toHaveText('1 of 2');
  await window.keyboard.press('ArrowDown');
  await expect(leftPanel.getByRole('row', { name: 'alpha-two.txt' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await leftSearch.fill('beta');
  await expect(leftPanel.getByRole('row', { name: 'beta.txt' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await window.keyboard.press('Escape');
  await expect(leftSearch).toHaveCount(0);
  await expect(leftPanel.getByRole('row', { name: 'beta.txt' })).toBeFocused();
  await leftPanel.getByRole('row', { name: 'beta.txt' }).dblclick();
  await expect
    .poll(() =>
      electronApplication?.evaluate(() => {
        const mainProcessState = globalThis as typeof globalThis & {
          __openscpOpenedPaths?: string[];
        };
        return mainProcessState.__openscpOpenedPaths;
      }),
    )
    .toEqual([join(fixtureRootPath, 'beta.txt')]);

  await rightPanel.getByRole('row', { name: 'alpha-one.txt' }).click();
  await window.keyboard.type('alpha');
  const rightSearch = rightPanel.getByRole('searchbox', { name: 'Search files and folders' });
  await expect(rightSearch).toHaveValue('alpha');
  await expect(rightPanel.getByRole('status')).toHaveText('1 of 2');
  await window.keyboard.press('ArrowUp');
  await expect(rightPanel.getByRole('row', { name: 'alpha-two.txt' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
