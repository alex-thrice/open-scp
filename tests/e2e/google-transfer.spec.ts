import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { DesktopApi } from '../../src/shared/desktop-api';
import { ipcRequestChannels } from '../../src/shared/ipc/channels';
import type { WorkspaceSnapshot } from '../../src/shared/ipc/workspace';
import { finishProfile, newConnection, openConnection } from './workspace-ui';
import { nativeKeyringLaunchOptions } from './electron-launch';

test('keeps two Google rclone accounts separate from iCloud connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscp-google-rclone-ui-'));
  const userData = await mkdtemp(join(tmpdir(), 'openscp-google-rclone-user-'));
  const packagedPath = process.env.OPENSCP_PACKAGED_EXE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      ...nativeKeyringLaunchOptions(packagedPath),
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        '--no-sandbox',
        `--user-data-dir=${userData}`,
        ...(packagedPath ? [] : [resolve('out/main/index.js')]),
      ],
      env: {
        ...process.env,
        OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
        OPENSCP_LOCAL_ROOT: root,
        OPENSCP_RCLONE_PATH: join(root, 'missing-rclone.exe'),
      },
    });
    const page = await application.firstWindow();
    const snapshot = await page.evaluate(async () => {
      const response = await (Reflect.get(globalThis, 'desktop') as DesktopApi).workspace({
        action: 'snapshot',
      });
      if (!response.ok) throw new Error(response.error.code);
      return response.data.snapshot;
    });
    await application.evaluate(
      ({ ipcMain }, { channel, snapshot }) => {
        const state: WorkspaceSnapshot = {
          ...snapshot,
          rcloneAvailable: true,
          googleRemotes: ['google-personal', 'google-work'],
          icloudRemotes: ['apple-account'],
        };
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, request) => {
          const payload = request.payload;
          const data: Record<string, unknown> = {
            snapshot: state,
            listing: null,
            privateKeyPath: null,
          };
          if (payload.action === 'begin-profile-edit')
            data.profileEditId = 'b13670f7-c900-41d8-a6b0-c4b1f7f961ba';
          else if (payload.action === 'save-google-profile') {
            state.profiles = [...state.profiles, { ...payload.profile, kind: 'google' }];
            data.savedProfileId = payload.profile.id;
          } else if (payload.action === 'connect') {
            const profile = state.profiles.find((item) => item.id === payload.profileId);
            if (profile)
              state.sessions = [
                ...state.sessions.filter((item) => item.workspaceId !== payload.workspaceId),
                {
                  workspaceId: payload.workspaceId,
                  profileId: profile.id,
                  name: profile.name,
                  kind: profile.kind,
                  state: 'connected',
                  hostKey: null,
                  currentPath: '/',
                },
              ];
          } else if (payload.action === 'list') {
            const session = state.sessions.find((item) => item.workspaceId === payload.workspaceId);
            const profile = state.profiles.find((item) => item.id === session?.profileId);
            if (profile?.kind === 'google')
              data.listing = {
                breadcrumbs: [{ label: '/', path: '/' }],
                currentPath: '/',
                parentPath: null,
                entries: [
                  {
                    name: `${profile.remote}.txt`,
                    path: `/${profile.remote}.txt`,
                    kind: 'file',
                    size: 12n,
                    modifiedAt: null,
                    permissions: null,
                  },
                ],
              };
          }
          return { correlationId: request.correlationId, ok: true, data };
        });
      },
      { channel: ipcRequestChannels.workspace, snapshot },
    );

    for (const account of ['personal', 'work']) {
      const form = await newConnection(page, 'google');
      const remote = form.getByLabel('Google Drive connection in rclone');
      await expect(remote).toBeEnabled();
      await expect(remote.locator('option')).toHaveText(['google-personal', 'google-work']);
      await expect(form.getByRole('button', { name: 'Sign in to Google' })).toHaveCount(0);
      await form.getByLabel('Profile name').fill(`Google ${account}`);
      await remote.selectOption(`google-${account}`);
      await finishProfile(page, form);
    }
    await openConnection(page, 'left', 'Google personal');
    await openConnection(page, 'right', 'Google work');
    const left = page.getByTestId('left-panel');
    const right = page.getByTestId('right-panel');
    await expect(left.getByRole('row', { name: 'google-personal.txt', exact: true })).toBeVisible();
    await expect(left.getByRole('row', { name: 'google-work.txt', exact: true })).toHaveCount(0);
    await expect(right.getByRole('row', { name: 'google-work.txt', exact: true })).toBeVisible();
    await expect(right.getByRole('row', { name: 'google-personal.txt', exact: true })).toHaveCount(
      0,
    );
    await expect(left.getByRole('textbox', { name: 'Current path', exact: true })).toHaveValue('/');
    await expect(left.getByRole('textbox', { name: 'Current path', exact: true })).toBeEditable();
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
