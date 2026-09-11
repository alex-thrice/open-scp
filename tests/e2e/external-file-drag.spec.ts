import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

test('passes selected local files through the preload bridge to native drag', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openscp-native-drag-test-')));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-native-drag-user-'));
  let application: ElectronApplication | undefined;
  try {
    const paths = [join(root, 'one.txt'), join(root, 'two.txt')];
    for (const path of paths) await writeFile(path, 'drag fixture');
    const executablePath = process.env.OPENSCP_PACKAGED_EXE;
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        '--no-sandbox',
        `--user-data-dir=${userData}`,
        ...(executablePath ? [] : [resolve('out/main/index.js')]),
      ],
      env: { ...process.env, OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1', OPENSCP_LOCAL_ROOT: root },
    });
    const window = await application.firstWindow();
    const panel = window.getByTestId('left-panel');
    const currentPath = panel.getByLabel('Current path');
    await currentPath.fill(root);
    await currentPath.press('Enter');
    await expect(panel.getByRole('row', { name: 'one.txt' })).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!contents) throw new Error('Missing main window');
      // Системную операцию подменяем, чтобы тест не зависал в цикле перетаскивания ОС.
      contents.startDrag = (item) => {
        Reflect.set(globalThis, 'nativeDragResult', {
          files: item.files,
          hasIcon: typeof item.icon === 'string' || !item.icon.isEmpty(),
        });
      };
    });
    await panel.getByRole('row', { name: 'one.txt' }).click();
    await panel.getByRole('row', { name: 'two.txt' }).click({ modifiers: ['ControlOrMeta'] });
    await panel.getByRole('row', { name: 'one.txt' }).dispatchEvent('dragstart');
    await expect
      .poll(() => application?.evaluate(() => Reflect.get(globalThis, 'nativeDragResult')))
      .toEqual({ files: paths, hasIcon: true });
    await expect(panel.getByRole('alert')).toHaveCount(0);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
