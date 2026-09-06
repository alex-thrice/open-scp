import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server, utils, type Connection } from 'ssh2';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import {
  expectSourceIndicatorAtEnd,
  finishProfile,
  newConnection,
  openConnection,
} from './workspace-ui';

const { sftp } = utils;

for (const side of ['left', 'right'] as const) {
  for (const authenticate of [true, false]) {
    test(`keeps the ${side} pane usable after SFTP host trust and ${authenticate ? 'connection' : 'authentication failure'}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'openscp-sftp-pane-files-'));
      const userData = await mkdtemp(join(tmpdir(), 'openscp-sftp-pane-user-'));
      const clients = new Set<Connection>();
      const listedPaths: string[] = [];
      const server = new Server(
        { hostKeys: [utils.generateKeyPairSync('ed25519').private] },
        (client) => {
          clients.add(client);
          // Первый обмен намеренно прерывается до подтверждения ключа в интерфейсе.
          client.on('error', () => undefined);
          client.on('close', () => clients.delete(client));
          client.on('authentication', (context) => {
            if (
              authenticate &&
              context.method === 'password' &&
              context.username === 'fixture' &&
              context.password === 'fixture-password-only'
            )
              context.accept();
            else context.reject(['password']);
          });
          client.on('ready', () => {
            client.on('session', (acceptSession) => {
              acceptSession().on('sftp', (acceptSftp) => {
                const stream = acceptSftp();
                const handles = new Map<string, boolean>();
                let sequence = 0;
                const attributes = {
                  mode: 0o100644,
                  uid: 1000,
                  gid: 1000,
                  size: 12,
                  atime: 1788264000,
                  mtime: 1788264000,
                };
                stream.on('REALPATH', (id, path) => {
                  stream.name(id, [
                    {
                      filename: path === '.' ? '/fixture' : path,
                      longname: '',
                      attrs: { ...attributes, mode: 0o40755 },
                    },
                  ]);
                });
                stream.on('OPENDIR', (id, path) => {
                  listedPaths.push(path);
                  if (path !== '/fixture') {
                    stream.status(id, sftp.STATUS_CODE.NO_SUCH_FILE);
                    return;
                  }
                  const handle = String(++sequence);
                  handles.set(handle, false);
                  stream.handle(id, Buffer.from(handle));
                });
                stream.on('READDIR', (id, handle) => {
                  const key = handle.toString();
                  if (!handles.has(key)) stream.status(id, sftp.STATUS_CODE.FAILURE);
                  else if (handles.get(key)) stream.status(id, sftp.STATUS_CODE.EOF);
                  else {
                    handles.set(key, true);
                    stream.name(id, [
                      {
                        filename: 'remote.txt',
                        longname: '-rw-r--r-- 1 fixture fixture 12 Sep 1 12:00 remote.txt',
                        attrs: attributes,
                      },
                    ]);
                  }
                });
                stream.on('CLOSE', (id, handle) => {
                  handles.delete(handle.toString());
                  stream.status(id, sftp.STATUS_CODE.OK);
                });
              });
            });
          });
        },
      );
      let application: ElectronApplication | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No local SFTP fixture port.');
        await writeFile(join(root, 'local.txt'), 'Local pane fixture.');
        const executablePath = process.env.OPENSCP_PACKAGED_EXE;
        application = await electron.launch({
          ...(executablePath ? { executablePath } : {}),
          args: [
            '--disable-gpu',
            '--in-process-gpu',
            `--user-data-dir=${userData}`,
            ...(process.env.OPENSCP_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
            ...(executablePath ? [] : [resolve('out/main/index.js')]),
          ],
          env: { ...process.env, OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1' },
        });
        const page = await application.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const panel = page.getByTestId(`${side}-panel`);
        const other = page.getByTestId(`${side === 'left' ? 'right' : 'left'}-panel`);
        for (const localPanel of [panel, other]) {
          await expect(
            localPanel.getByRole('button', { name: 'Refresh', exact: true }),
          ).toBeEnabled();
          await localPanel.getByLabel('Current path').fill(root);
          await localPanel.getByLabel('Current path').press('Enter');
          await expect(
            localPanel.getByRole('row', { name: 'local.txt', exact: true }),
          ).toBeVisible();
          await expectSourceIndicatorAtEnd(localPanel);
        }
        const form = await newConnection(page, 'sftp');
        await form.getByLabel('Profile name').fill('Local SFTP fixture');
        await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
        await form.getByLabel('Port', { exact: true }).fill(String(address.port));
        await form.getByLabel('Username', { exact: true }).fill('fixture');
        await form.getByLabel('Password', { exact: true }).fill('fixture-password-only');
        await form.getByLabel('Initial directory').fill('/fixture');
        await finishProfile(page, form);
        await openConnection(page, side, 'Local SFTP fixture');
        await expect(panel.getByText(/Unknown server key/u)).toBeVisible();
        await expect(panel.getByRole('row', { name: 'local.txt', exact: true })).toHaveCount(0);
        await expect(other.getByRole('row', { name: 'local.txt', exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Drive or connection' })).toBeDisabled();
        await panel.getByRole('button', { name: 'Trust this key and connect' }).click();
        if (authenticate) {
          await expect(panel.getByRole('row', { name: 'remote.txt', exact: true })).toBeVisible();
          await expect(panel.getByLabel('Current path')).toHaveValue('/fixture');
          await expect(
            panel.getByRole('button', { name: 'New directory', exact: true }),
          ).toBeEnabled();
          expect(listedPaths.length).toBeGreaterThan(0);
          expect(listedPaths.every((path) => path === '/fixture')).toBe(true);
        } else {
          await expect(panel.getByRole('button', { name: 'Retry connection' })).toBeVisible();
          await expect(
            panel.getByRole('button', { name: 'Trust this key and connect' }),
          ).toHaveCount(0);
          await expect(
            panel.getByRole('button', { name: 'New directory', exact: true }),
          ).toBeDisabled();
          expect(listedPaths).toEqual([]);
        }
        await expectSourceIndicatorAtEnd(panel);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await expectSourceIndicatorAtEnd(panel);
        await expectSourceIndicatorAtEnd(other);
        await page.screenshot({ path: test.info().outputPath('sftp-pane.png') });
        expect(errors).toEqual([]);
        await page.getByRole('button', { name: /^Close /u }).click();
        await expect(page.getByRole('tabpanel')).toHaveAttribute(
          'data-workspace-id',
          'workspace-2',
        );
        await expect(
          page.getByTestId('left-panel').getByRole('button', { name: 'Drive or connection' }),
        ).toBeEnabled();
        await expect(
          page.getByTestId('right-panel').getByRole('button', { name: 'Drive or connection' }),
        ).toBeEnabled();
      } finally {
        await application?.close();
        for (const client of clients) client.end();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        await rm(userData, { recursive: true, force: true });
      }
    });
  }
}
