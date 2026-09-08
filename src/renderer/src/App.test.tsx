import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DesktopApi } from '@shared/desktop-api';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import type { LocalDirectoryListing } from '@shared/ipc/contracts';
import { createS3ProviderPath } from '@shared/models/provider-path';
import { formatS3Path } from '@shared/models/s3-path';
import { defaultKeyboardShortcuts } from '@shared/models/keyboard-shortcuts';
import { defaultUpdateSettings } from '@shared/models/application-update';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { i18n } from './i18n';

const correlationId = '00000000-0000-4000-8000-000000000001';
const driveRootPath = 'C:\\';
const usersPath = 'C:\\Users';
const rootPath = 'C:\\Users\\test';
const childPath = `${rootPath}\\Documents`;

const rootListing: LocalDirectoryListing = {
  breadcrumbs: [
    { label: driveRootPath, path: driveRootPath },
    { label: 'Users', path: usersPath },
    { label: 'test', path: rootPath },
  ],
  currentPath: rootPath,
  entries: [
    {
      kind: 'directory',
      modifiedAt: '2026-08-30T12:00:00.000Z',
      name: 'Documents',
      path: childPath,
      size: 0n,
    },
    {
      kind: 'file',
      modifiedAt: '2026-08-30T12:00:00.000Z',
      name: 'notes.txt',
      path: `${rootPath}\\notes.txt`,
      size: 42n,
    },
  ],
  parentPath: usersPath,
};

const createDesktopApi = (listLocalDirectory: DesktopApi['listLocalDirectory']): DesktopApi => {
  const desktopApi: DesktopApi = {
    workspace: async () => ({
      correlationId,
      ok: true,
      data: {
        snapshot: { profiles: [], sessions: [], transfers: [], language: null },
        listing: null,
        privateKeyPath: null,
      },
    }),
    getRuntimeInfo: async () => ({
      correlationId,
      data: { platform: 'win32', runtime: 'electron' },
      ok: true,
    }),
    listLocalDirectory,
    listLocalDrives: async () => ({
      correlationId,
      data: [
        { label: driveRootPath, path: driveRootPath },
        { label: 'D:\\', path: 'D:\\' },
      ],
      ok: true,
    }),
    onAppReady: () => () => undefined,
    runtime: 'electron',
  };

  return Object.freeze(desktopApi);
};

const setDesktopApi = (desktopApi: DesktopApi): void => {
  Object.defineProperty(window, 'desktop', { configurable: true, value: desktopApi });
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const pane = (side: 'left' | 'right') =>
  within(within(screen.getByRole('tabpanel')).getByTestId(side + '-panel'));
const chooseDrive = async (side: 'left' | 'right', path: string) => {
  fireEvent.click(pane(side).getByRole('button', { name: 'Drive or connection' }));
  const search = await screen.findByRole('combobox', { name: 'Search by name…' });
  fireEvent.change(search, { target: { value: path } });
  fireEvent.click(await screen.findByRole('option'));
};
const childListing: LocalDirectoryListing = {
  ...rootListing,
  currentPath: childPath,
  entries: [],
  parentPath: rootPath,
};
const secondDrive: LocalDirectoryListing = {
  breadcrumbs: [{ label: 'D:\\', path: 'D:\\' }],
  currentPath: 'D:\\',
  entries: [],
  parentPath: null,
};
const listingApi = () =>
  vi.fn(async (path: string | null) => ({
    correlationId,
    data: path === childPath ? childListing : path === 'D:\\' ? secondDrive : rootListing,
    ok: true as const,
  }));
const profiles: WorkspaceSnapshot['profiles'] = [
  {
    id: 'sftp-one',
    kind: 'sftp',
    name: 'Development',
    host: 'dev.example.test',
    username: 'alex',
    port: 22,
    authentication: { method: 'agent' },
  },
  {
    id: 's3-one',
    kind: 's3',
    name: 'Archives',
    region: 'us-east-1',
    accessKeyId: 'fixture',
    initialPrefix: '',
    forcePathStyle: false,
  },
];
const statefulApi = (initial: Partial<WorkspaceSnapshot> = {}) => {
  let snapshot: WorkspaceSnapshot = {
    profiles,
    sessions: [],
    transfers: [],
    language: null,
    confirmTabClose: true,
    keyboardShortcuts: defaultKeyboardShortcuts,
    profileFolders: ['Work', 'Storage'],
    profileGroups: { 'sftp-one': 'Work', 's3-one': 'Storage' },
    ...initial,
  };
  const workspace = vi.fn<DesktopApi['workspace']>(async (request) => {
    if (request.action === 'set-appearance')
      snapshot = { ...snapshot, appearance: request.appearance };
    if (request.action === 'set-language') snapshot = { ...snapshot, language: request.language };
    if (request.action === 'set-putty-path') snapshot = { ...snapshot, puttyPath: request.path };
    if (request.action === 'set-editor-path') snapshot = { ...snapshot, editorPath: request.path };
    if (request.action === 'set-confirm-tab-close')
      snapshot = { ...snapshot, confirmTabClose: request.enabled };
    if (request.action === 'set-keyboard-shortcuts')
      snapshot = { ...snapshot, keyboardShortcuts: request.shortcuts };
    if (request.action === 'set-update-settings')
      snapshot = { ...snapshot, updateSettings: request.settings };
    if (request.action === 'set-remember-paths')
      snapshot = {
        ...snapshot,
        rememberPaths: request.enabled,
        ...(request.enabled ? {} : { localPathHistory: {}, localPaths: {}, recentPaths: {} }),
      };
    if (request.action === 'remember-workspace-layout')
      snapshot = { ...snapshot, workspaceLayout: request.layout };
    if (request.action === 'connect') {
      const profile = snapshot.profiles.find((item) => item.id === request.profileId);
      if (profile)
        snapshot = {
          ...snapshot,
          sessions: [
            ...snapshot.sessions,
            {
              workspaceId: request.workspaceId,
              profileId: profile.id,
              kind: profile.kind,
              name: profile.name,
              currentPath:
                profile.kind === 's3'
                  ? formatS3Path(
                      createS3ProviderPath(profile.bucket ?? '', profile.initialPrefix ?? ''),
                    )
                  : '/',
              hostKey: null,
              state: 'connected',
              capabilities: {
                read: true,
                write: true,
                rename: true,
                delete: true,
                createDirectory: true,
                serverSideCopy: false,
              },
            },
          ],
        };
    }
    if (request.action === 'disconnect' || request.action === 'close-session')
      snapshot = {
        ...snapshot,
        sessions: snapshot.sessions.filter((item) => item.workspaceId !== request.workspaceId),
      };
    if (request.action === 'create-profile-folder')
      snapshot = {
        ...snapshot,
        profileFolders: [...(snapshot.profileFolders ?? []), request.name],
      };
    if (request.action === 'clone-profile') {
      const original = snapshot.profiles.find((item) => item.id === request.profileId);
      if (original)
        snapshot = {
          ...snapshot,
          profiles: [...snapshot.profiles, { ...original, id: 'duplicate', name: request.name }],
        };
    }
    const currentPath =
      request.action === 'list'
        ? (request.path ??
          snapshot.sessions.find((session) => session.workspaceId === request.workspaceId)
            ?.currentPath ??
          '/')
        : '/';
    return {
      correlationId,
      ok: true,
      data: {
        snapshot,
        listing:
          request.action === 'list'
            ? {
                breadcrumbs: [{ label: currentPath, path: currentPath }],
                currentPath,
                parentPath: null,
                entries: currentPath.startsWith('s3://')
                  ? currentPath === 's3:///'
                    ? [
                        {
                          name: 'example-bucket',
                          path: 's3://example-bucket/',
                          kind: 'directory',
                          s3Kind: 'bucket',
                          modifiedAt: null,
                          permissions: null,
                          size: 0n,
                        },
                      ]
                    : [
                        {
                          name: 'remote.txt',
                          path: `${currentPath}remote.txt`,
                          kind: 'file',
                          s3Kind: 'object',
                          modifiedAt: null,
                          permissions: null,
                          size: 12n,
                        },
                      ]
                  : [],
              }
            : null,
        privateKeyPath: null,
        ...(request.action === 'pick-editor'
          ? { selectedPath: 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe' }
          : {}),
        ...(request.action === 'clone-profile' ? { savedProfileId: 'duplicate' } : {}),
      },
    };
  });
  setDesktopApi({ ...createDesktopApi(listingApi()), workspace });
  return workspace;
};

describe('App', () => {
  it.each([
    { side: 'left', bucket: '' },
    { side: 'right', bucket: '' },
    { side: 'left', bucket: 'example-bucket' },
    { side: 'right', bucket: 'example-bucket' },
  ] as const)(
    'switches a populated $side local pane to S3 with bucket "$bucket"',
    async ({ side, bucket }) => {
      statefulApi({
        profiles: profiles.map((profile) =>
          profile.kind === 's3' ? { ...profile, bucket } : profile,
        ),
      });
      render(<App />);
      await pane(side).findByRole('row', { name: 'notes.txt' });
      fireEvent.click(pane(side).getByRole('button', { name: 'Drive or connection' }));
      fireEvent.click(await screen.findByRole('option', { name: /Archives/u }));
      const remotePath = `s3://${bucket}/`;
      await waitFor(() => expect(pane(side).getByDisplayValue(remotePath)).toBeTruthy());
      if (!bucket) {
        const row = await pane(side).findByRole('row', { name: 'Open example-bucket' });
        expect(
          (pane(side).getByRole('button', { name: 'New directory' }) as HTMLButtonElement).disabled,
        ).toBe(true);
        fireEvent.doubleClick(row);
        await pane(side).findByDisplayValue('s3://example-bucket/');
      }
      await pane(side).findByRole('row', { name: 'remote.txt' });
      expect(pane(side).queryByRole('row', { name: 'notes.txt' })).toBeNull();
      expect(
        pane(side === 'left' ? 'right' : 'left').getByRole('row', { name: 'notes.txt' }),
      ).toBeTruthy();
      expect(
        (pane(side).getByRole('button', { name: 'Drive or connection' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (pane(side).getByRole('button', { name: 'New directory' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );

  it('requires confirmation before closing a pane with unfinished transfers', async () => {
    const workspace = statefulApi({
      sessions: [
        {
          workspaceId: 'workspace-1:right',
          profileId: 'sftp-one',
          kind: 'sftp',
          name: 'Development',
          currentPath: '/',
          state: 'connected',
          hostKey: null,
        },
      ],
      transfers: [
        {
          id: 'transfer-one',
          workspaceId: 'workspace-1:right',
          sourcePath: '/source',
          destinationPath: '/target',
          direction: 'upload',
          state: 'queued',
          conflictPolicy: 'ask',
          transferredBytes: 0n,
          totalBytes: 10n,
          speed: 0,
          elapsed: 0,
          remaining: null,
          errorKey: null,
          conflictPath: null,
        },
      ],
    });
    render(<App />);
    await screen.findByRole('tab', { name: 'test - Development' });
    fireEvent.click(screen.getByRole('button', { name: 'Close test - Development' }));
    await screen.findByRole('dialog', { name: 'Close tab?' });
    expect(workspace.mock.calls.some(([request]) => request.action === 'disconnect')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep tab open' }));
    expect(screen.getByRole('tab', { name: 'test - Development' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close test - Development' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt and close' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'close-session',
        workspaceId: 'workspace-1:right',
        cancelActive: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('tabpanel').dataset.workspaceId).toBe('workspace-2'),
    );
  });

  it('restores tab ownership for journal entries with per-panel workspace IDs', async () => {
    statefulApi({
      transfers: [
        {
          id: 'restored',
          workspaceId: 'workspace-3:left',
          destinationWorkspaceId: 'workspace-4:right',
          sourcePath: '/source',
          destinationPath: '/target',
          direction: 'remote',
          state: 'requiring-review',
          conflictPolicy: 'ask',
          transferredBytes: 0n,
          totalBytes: 10n,
          speed: 0,
          elapsed: 0,
          remaining: null,
          errorKey: null,
          conflictPath: null,
        },
      ],
    });
    render(<App />);
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
    expect(screen.getByRole('tabpanel').dataset.workspaceId).toBe('workspace-5');
  });

  it('does not keep a provisional default tab when migrating saved pane paths', async () => {
    statefulApi({
      localPaths: {
        'workspace-1:left': rootPath,
        'workspace-2:left': childPath,
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('tabpanel').dataset.workspaceId).toBe('workspace-2'),
    );
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    await waitFor(() =>
      expect(pane('left').getByLabelText('Current path')).toHaveProperty('value', childPath),
    );
  });
  it('renders two local panels, per-panel icon actions and a folder-based tab title', async () => {
    setDesktopApi(createDesktopApi(listingApi()));
    render(<App />);
    expect(await screen.findByRole('tab', { name: 'test - test' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'OpenSCP' })).toBeTruthy();
    for (const side of ['left', 'right'] as const) {
      expect(pane(side).getByRole('row', { name: 'notes.txt' })).toBeTruthy();
      for (const name of ['New directory', 'Rename', 'Delete']) {
        const button = pane(side).getByRole('button', { name });
        expect(button.textContent).toBe('');
        expect(button.title).toContain(name);
      }
    }
    expect(screen.queryByRole('heading', { name: 'Local' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Remote' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Close /u })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Transfer queue' })).toBeTruthy();
  });

  it('uses only the narrow frozen preload contract', () => {
    setDesktopApi(createDesktopApi(listingApi()));
    expect(Object.keys(window.desktop).sort()).toEqual([
      'getRuntimeInfo',
      'listLocalDirectory',
      'listLocalDrives',
      'onAppReady',
      'runtime',
      'workspace',
    ]);
    expect(Object.isFrozen(window.desktop)).toBe(true);
  });

  it('keeps drives and paths independent between both panels and tabs', async () => {
    const list = listingApi();
    setDesktopApi(createDesktopApi(list));
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    await chooseDrive('left', 'D:\\');
    expect(await screen.findByRole('tab', { name: 'D: - test' })).toBeTruthy();
    expect(pane('left').getByText('This directory is empty.')).toBeTruthy();
    expect(pane('right').getByRole('row', { name: 'notes.txt' })).toBeTruthy();
    expect(
      (pane('left').getByRole('button', { name: 'Go to parent directory' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
    await chooseDrive('left', 'C:\\');
    expect(await screen.findByRole('tab', { name: 'test - test' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'D: - test' }));
    expect((pane('left').getByLabelText('Current path') as HTMLInputElement).value).toBe('D:\\');
  });

  it('leaves the source picker usable after initial and subsequent access errors', async () => {
    const list = vi.fn(async (path: string | null) =>
      path === null || path === 'D:\\'
        ? {
            correlationId,
            ok: false as const,
            error: {
              code: 'PROVIDER_ACCESS_DENIED' as const,
              messageKey: 'errors.provider.accessDenied' as const,
            },
          }
        : { correlationId, ok: true as const, data: rootListing },
    );
    setDesktopApi(createDesktopApi(list));
    render(<App />);
    await pane('left').findByRole('alert');
    await chooseDrive('left', 'C:\\');
    await pane('left').findByRole('row', { name: 'notes.txt' });
    await chooseDrive('left', 'D:\\');
    expect(await pane('left').findByRole('alert')).toBeTruthy();
    expect((pane('left').getByLabelText('Current path') as HTMLInputElement).value).toBe(rootPath);
    fireEvent.click(pane('left').getByRole('button', { name: 'Back' }));
    expect(pane('left').queryByRole('alert')).toBeNull();
    expect(pane('left').getByRole('row', { name: 'notes.txt' })).toBeTruthy();
  });

  it('refreshes removable drives when opening the source list', async () => {
    let drives = [{ label: 'C:\\', path: 'C:\\' }];
    setDesktopApi({
      ...createDesktopApi(listingApi()),
      listLocalDrives: async () => ({ correlationId, ok: true, data: drives }),
    });
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    drives = [...drives, { label: 'E:\\', path: 'E:\\' }];
    fireEvent.click(pane('left').getByRole('button', { name: 'Drive or connection' }));
    expect(await screen.findByRole('option', { name: /E:/u })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    drives = [{ label: 'C:\\', path: 'C:\\' }];
    fireEvent.click(pane('left').getByRole('button', { name: 'Drive or connection' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: /E:/u })).toBeNull());
  });

  it('ignores stale listings after switching a drive', async () => {
    let complete:
      ((value: Awaited<ReturnType<DesktopApi['listLocalDirectory']>>) => void) | undefined;
    const pending = new Promise<Awaited<ReturnType<DesktopApi['listLocalDirectory']>>>(
      (resolve) => {
        complete = resolve;
      },
    );
    setDesktopApi(
      createDesktopApi(async (path) =>
        path === null ? pending : { correlationId, ok: true, data: secondDrive },
      ),
    );
    render(<App />);
    await chooseDrive('left', 'D:\\');
    await pane('left').findByText('This directory is empty.');
    await act(async () => complete?.({ correlationId, ok: true, data: rootListing }));
    expect(pane('left').queryByRole('row', { name: 'notes.txt' })).toBeNull();
    expect(pane('right').getByRole('row', { name: 'notes.txt' })).toBeTruthy();
  });

  it('navigates into a folder, edits its path, and goes to the parent', async () => {
    const list = listingApi();
    setDesktopApi(createDesktopApi(list));
    render(<App />);
    fireEvent.doubleClick(await pane('left').findByRole('row', { name: 'Open Documents' }));
    await screen.findByRole('tab', { name: 'Documents - test' });
    fireEvent.click(pane('left').getByRole('button', { name: 'Go to parent directory' }));
    await screen.findByRole('tab', { name: 'test - test' });
    const input = pane('left').getByLabelText('Current path');
    fireEvent.change(input, { target: { value: usersPath } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(usersPath));
  });

  it('restores file-list focus after entering a directory', async () => {
    const nestedListing: LocalDirectoryListing = {
      ...childListing,
      entries: [
        {
          kind: 'directory',
          modifiedAt: null,
          name: 'Alpha',
          path: `${childPath}\\Alpha`,
          size: 0n,
        },
        {
          kind: 'directory',
          modifiedAt: null,
          name: 'Beta',
          path: `${childPath}\\Beta`,
          size: 0n,
        },
      ],
    };
    const list = vi.fn(async (path: string | null) => ({
      correlationId,
      data: path === childPath ? nestedListing : rootListing,
      ok: true as const,
    }));
    setDesktopApi(createDesktopApi(list));
    render(<App />);
    const directory = await pane('left').findByRole('row', { name: 'Open Documents' });
    fireEvent.click(directory);
    fireEvent.doubleClick(directory);
    const firstNestedDirectory = await pane('left').findByRole('row', { name: 'Open Alpha' });
    await waitFor(() => expect(document.activeElement).toBe(firstNestedDirectory));
    fireEvent.keyDown(firstNestedDirectory, { key: 'ArrowDown' });
    const secondNestedDirectory = pane('left').getByRole('row', { name: 'Open Beta' });
    await waitFor(() => expect(document.activeElement).toBe(secondNestedDirectory));
    fireEvent.keyDown(secondNestedDirectory, { key: 'Backspace' });
    const restoredDirectory = await pane('left').findByRole('row', { name: 'Open Documents' });
    await waitFor(() => expect(document.activeElement).toBe(restoredDirectory));
  });

  it('opens a local file through the constrained workspace action', async () => {
    const workspace = statefulApi();
    render(<App />);
    fireEvent.doubleClick(await pane('left').findByRole('row', { name: 'notes.txt' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'open-local-file',
        workspaceId: 'workspace-1:left',
        path: `${rootPath}\\notes.txt`,
      }),
    );
  });

  it('retries the failed requested path, preserving the previous directory', async () => {
    const list = vi.fn(async (path: string | null) =>
      path === childPath
        ? {
            correlationId,
            ok: false as const,
            error: {
              code: 'PROVIDER_ACCESS_DENIED' as const,
              messageKey: 'errors.provider.accessDenied' as const,
            },
          }
        : { correlationId, ok: true as const, data: rootListing },
    );
    setDesktopApi(createDesktopApi(list));
    render(<App />);
    fireEvent.doubleClick(await pane('left').findByRole('row', { name: 'Open Documents' }));
    await pane('left').findByRole('alert');
    fireEvent.click(pane('left').getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    expect(list).toHaveBeenLastCalledWith(childPath);
    expect(pane('left').getByRole('row', { name: 'notes.txt' })).toBeTruthy();
  });

  it('switches the active pane using F6 and keeps selection independent', async () => {
    setDesktopApi(createDesktopApi(listingApi()));
    render(<App />);
    const row = await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'F6' });
    const right = screen.getByTestId('right-panel');
    expect(right.contains(document.activeElement)).toBe(true);
    expect(right.dataset.active).toBe('true');
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(
      pane('right').getByRole('row', { name: 'notes.txt' }).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('adds and closes workspaces with shortcuts without closing the last local tab', async () => {
    const workspace = statefulApi();
    render(<App />);
    await screen.findByRole('tab', { name: 'test - test' });
    fireEvent.keyDown(screen.getByRole('main'), { ctrlKey: true, key: 't' });
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    fireEvent.keyDown(screen.getByRole('main'), { ctrlKey: true, key: 'w' });
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    expect(workspace).toHaveBeenCalledWith({
      action: 'disconnect',
      workspaceId: 'workspace-2:left',
    });
    fireEvent.keyDown(screen.getByRole('main'), { ctrlKey: true, key: 'w' });
    expect(screen.queryByRole('button', { name: /^Close /u })).toBeNull();
  });

  it('reassigns a keyboard shortcut and can disable tab close confirmation', async () => {
    const workspace = statefulApi();
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const shortcutRow = screen.getByText('New workspace').closest('div');
    if (!shortcutRow) throw new Error('Missing shortcut row.');
    const shortcutButton = within(shortcutRow).getByRole('button');
    fireEvent.click(shortcutButton);
    fireEvent.keyDown(shortcutButton, { ctrlKey: true, key: 'n' });
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'set-keyboard-shortcuts',
        shortcuts: {
          ...defaultKeyboardShortcuts,
          newWorkspace: { key: 'N', primary: true, alt: false, shift: false },
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Confirm before closing tabs/u }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({ action: 'set-confirm-tab-close', enabled: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    fireEvent.keyDown(screen.getByRole('main'), { ctrlKey: true, key: 'n' });
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    fireEvent.keyDown(screen.getByRole('main'), { ctrlKey: true, key: 'w' });
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'Close tab?' })).toBeNull();
  });

  it('queues local copies immediately and defers conflict decisions', async () => {
    const workspace = statefulApi();
    render(<App />);
    fireEvent.doubleClick(await pane('right').findByRole('row', { name: 'Open Documents' }));
    await screen.findByRole('tab', { name: 'test - Documents' });
    fireEvent.click(pane('left').getByRole('row', { name: 'notes.txt' }));
    fireEvent.keyDown(pane('left').getByRole('row', { name: 'notes.txt' }), { key: 'F5' });
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'local-transfer',
        workspaceId: 'workspace-1:left',
        sourcePath: rootPath + '\\notes.txt',
        destinationDirectory: childPath,
        conflictPolicy: 'ask',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Copy' })).toBeNull();
  });

  it('uses F4 for editing and Ctrl+F5 for refreshing the active pane', async () => {
    const workspace = statefulApi();
    render(<App />);
    const row = await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'F4' });
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'edit-file',
        workspaceId: 'workspace-1:left',
        path: `${rootPath}\\notes.txt`,
      }),
    );
    const listLocalDirectory = vi.mocked(window.desktop.listLocalDirectory);
    listLocalDirectory.mockClear();
    fireEvent.keyDown(row, { ctrlKey: true, key: 'F5' });
    await waitFor(() => expect(listLocalDirectory).toHaveBeenCalledWith(rootPath));
    expect(workspace.mock.calls.some(([request]) => request.action === 'local-transfer')).toBe(
      false,
    );
    expect(pane('left').getByRole('button', { name: 'Refresh' }).title).toContain('Ctrl+F5');
  });

  it('asks about an actual transfer conflict and scopes apply-to-all to that transfer', async () => {
    const workspace = statefulApi({
      transfers: [
        {
          id: 'conflicting-transfer',
          workspaceId: 'workspace-1:left',
          sourcePath: 'C:\\source.txt',
          destinationPath: 'D:\\source.txt',
          direction: 'download',
          state: 'requiring-review',
          conflictPolicy: 'ask',
          transferredBytes: 0n,
          totalBytes: 10n,
          speed: 0,
          elapsed: 0,
          remaining: null,
          errorKey: null,
          conflictPath: 'D:\\source.txt',
          conflictSourcePath: 'C:\\source.txt',
        },
      ],
    });
    render(<App />);
    const prompt = await screen.findByRole('alertdialog');
    fireEvent.click(
      within(prompt).getByRole('checkbox', {
        name: 'Apply this decision to all remaining conflicts in this transfer',
      }),
    );
    fireEvent.click(within(prompt).getByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'resolve-conflict',
        id: 'conflicting-transfer',
        policy: 'skip',
        applyToAll: true,
      }),
    );
  });

  it('restores local pane and per-drive paths and falls back to the nearest parent', async () => {
    statefulApi({
      localPaths: { 'workspace-1:left': `${childPath}\\missing` },
      localPathHistory: { 'D:\\': 'D:\\Projects' },
    });
    const list = vi.fn(async (path: string | null) => {
      if (path === `${childPath}\\missing`)
        return {
          correlationId,
          ok: false as const,
          error: {
            code: 'PROVIDER_NOT_FOUND' as const,
            messageKey: 'errors.provider.notFound' as const,
          },
        };
      if (path === 'D:\\Projects')
        return {
          correlationId,
          ok: true as const,
          data: { ...secondDrive, currentPath: path },
        };
      return {
        correlationId,
        ok: true as const,
        data: path === childPath ? childListing : rootListing,
      };
    });
    setDesktopApi({ ...window.desktop, listLocalDirectory: list });
    render(<App />);
    expect(
      await pane('left').findByText(
        'The saved path is unavailable. The nearest available location was opened.',
      ),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledWith(childPath);
    await chooseDrive('left', 'D:\\');
    await waitFor(() => expect(list).toHaveBeenCalledWith('D:\\Projects'));
  });

  it('shows SFTP connection progress with cancellation and a correctable password prompt', async () => {
    const workspace = statefulApi({
      sessions: [
        {
          workspaceId: 'workspace-1:left',
          profileId: 'sftp-one',
          kind: 'sftp',
          name: 'Development',
          state: 'connecting',
          connectionStage: 'handshaking',
          hostKey: null,
        },
        {
          workspaceId: 'workspace-1:right',
          profileId: 'sftp-one',
          kind: 'sftp',
          name: 'Development',
          state: 'failed',
          connectionStage: 'failed',
          connectionErrorKey: 'errors.security.authenticationFailed',
          passwordRequired: true,
          hostKey: null,
        },
      ],
    });
    render(<App />);
    await screen.findByRole('tab', { name: 'Development - Development' });
    expect(await pane('left').findByText('Negotiating SSH connection')).toBeTruthy();
    expect(pane('left').getByRole('progressbar', { name: 'Connection progress' })).toBeTruthy();
    fireEvent.click(pane('left').getByRole('button', { name: 'Cancel connection' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'cancel-connect',
        workspaceId: 'workspace-1:left',
      }),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Connection password' });
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'corrected-password' },
    });
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Save password in secure system storage' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'provide-password',
        workspaceId: 'workspace-1:right',
        password: 'corrected-password',
        save: true,
      }),
    );
  });

  it('offers to upload a changed remote editor copy', async () => {
    const workspace = statefulApi({
      externalEdits: [
        {
          id: 'external-edit-one',
          workspaceId: 'workspace-1:right',
          remotePath: '/remote.txt',
          fileName: 'remote.txt',
          state: 'changed',
          errorKey: null,
        },
      ],
    });
    render(<App />);
    const dialog = await screen.findByRole('dialog', { name: 'Edited remote file' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload changes' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'resolve-external-edit',
        id: 'external-edit-one',
        resolution: 'upload',
      }),
    );
  });

  it('searches grouped profiles by name and shows protocol and drive icons', async () => {
    statefulApi();
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(pane('left').getByRole('button', { name: 'Drive or connection' }));
    const drive = await screen.findByRole('option', { name: /C:/u });
    expect(drive.querySelector('[data-icon="HardDrive"]')).toBeTruthy();
    expect(
      screen.getByRole('option', { name: /Archives/u }).querySelector('[data-icon="Database"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('option', { name: /Development/u })
        .querySelector('[data-icon="ShieldCheck"]'),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Storage' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'arch' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev.example.test' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('locks a connected pane and closes the last remote tab into a new local workspace', async () => {
    const workspace = statefulApi();
    render(<App />);
    await pane('right').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(pane('right').getByRole('button', { name: 'Drive or connection' }));
    fireEvent.click(await screen.findByRole('option', { name: /Development/u }));
    await screen.findByRole('tab', { name: 'test - Development' });
    expect(
      (pane('right').getByRole('button', { name: 'Drive or connection' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (pane('left').getByRole('button', { name: 'Drive or connection' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close test - Development' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }));
    await screen.findByRole('tab', { name: 'test - test' });
    expect(workspace).toHaveBeenCalledWith({
      action: 'disconnect',
      workspaceId: 'workspace-1:right',
    });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tabpanel').dataset.workspaceId).toBe('workspace-2');
  });

  it('shows the SSH terminal action only for a connected SFTP pane', async () => {
    const workspace = statefulApi({
      sessions: [
        {
          workspaceId: 'workspace-1:right',
          profileId: 'sftp-one',
          kind: 'sftp',
          name: 'Development',
          currentPath: '/',
          state: 'connected',
          hostKey: null,
          capabilities: {
            read: true,
            write: true,
            rename: true,
            delete: true,
            createDirectory: true,
            serverSideCopy: false,
          },
        },
      ],
    });
    render(<App />);
    await screen.findByRole('tab', { name: 'test - Development' });
    const terminal = screen.getByRole('button', { name: 'Open SSH terminal' });
    expect(pane('left').queryByRole('button', { name: 'Open SSH terminal' })).toBeNull();
    fireEvent.click(terminal);
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'open-ssh-terminal',
        workspaceId: 'workspace-1:right',
      }),
    );
  });

  it('opens the PuTTY setting after an unavailable terminal error', async () => {
    const successfulWorkspace = statefulApi({
      sessions: [
        {
          workspaceId: 'workspace-1:right',
          profileId: 'sftp-one',
          kind: 'sftp',
          name: 'Development',
          currentPath: '/',
          state: 'connected',
          hostKey: null,
          capabilities: {
            read: true,
            write: true,
            rename: true,
            delete: true,
            createDirectory: true,
            serverSideCopy: false,
          },
        },
      ],
    });
    const workspace = vi.fn<DesktopApi['workspace']>(async (request) => {
      if (request.action === 'open-ssh-terminal')
        return {
          correlationId,
          ok: false,
          error: {
            code: 'EXTERNAL_APPLICATION_UNAVAILABLE',
            messageKey: 'errors.external.unavailable',
          },
        };
      return successfulWorkspace(request);
    });
    setDesktopApi({ ...window.desktop, workspace });

    render(<App />);
    await screen.findByRole('tab', { name: 'test - Development' });
    fireEvent.click(screen.getByRole('button', { name: 'Open SSH terminal' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Configure PuTTY' }));

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByLabelText('PuTTY executable path (Windows)')).toBeTruthy();
  });

  it('opens profiles in the active pane and prevents replacing its connection', async () => {
    const workspace = statefulApi();
    render(<App />);
    await screen.findByRole('tab', { name: 'test - test' });
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Development' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'connect',
        workspaceId: 'workspace-1:left',
        profileId: 'sftp-one',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Archives' }));
    expect(
      await screen.findByText(
        'This panel already has a connection. Use a local panel or a new tab.',
      ),
    ).toBeTruthy();
    expect(workspace.mock.calls.filter(([request]) => request.action === 'connect')).toHaveLength(
      1,
    );
  });

  it('shows SFTP, S3 and explicitly insecure FTP editors without a redundant Close button', async () => {
    statefulApi();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connection' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    const type = screen.getByLabelText('Connection type');
    expect(
      within(type)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['SFTP', 'S3', 'FTP']);
    fireEvent.change(type, { target: { value: 's3' } });
    expect(screen.getByText('S3-compatible storage')).toBeTruthy();
    expect(screen.getByLabelText('Secret access key')).toBeTruthy();
    expect(screen.queryByLabelText('Port')).toBeNull();
    fireEvent.change(screen.getByLabelText('Connection type'), { target: { value: 'ftp' } });
    expect(screen.getByText(/Unencrypted FTP sends the password/u)).toBeTruthy();
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('21');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Saved profiles')).toBeTruthy();
  });

  it('groups creation actions, creates empty folders, and duplicates profiles into the editor', async () => {
    const workspace = statefulApi();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    const create = screen.getByRole('group', { name: 'Create connection or folder' });
    expect(within(create).getByRole('button', { name: 'Connection' })).toBeTruthy();
    fireEvent.click(within(create).getByRole('button', { name: 'Folder' }));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Empty folder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'create-profile-folder',
        name: 'Empty folder',
      }),
    );
    expect(await screen.findByText('Empty folder')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate profile: Development' }));
    expect(await screen.findByDisplayValue('Development — Copy')).toBeTruthy();
  });

  it('persists theme, density and language through Settings, not the main toolbar', async () => {
    const workspace = statefulApi();
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Dark' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    fireEvent.change(screen.getByLabelText('List density'), { target: { value: 'compact' } });
    await waitFor(() =>
      expect(screen.getByRole('main', { hidden: true }).dataset.density).toBe('compact'),
    );
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ru' } });
    expect(await screen.findByRole('dialog', { name: 'Настройки' })).toBeTruthy();
    expect(workspace).toHaveBeenCalledWith({ action: 'set-language', language: 'ru' });
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(screen.getByRole('button', { name: 'Подключения' })).toBeTruthy();
  });

  it('remembers session paths by default and allows disabling path history', async () => {
    await i18n.changeLanguage('en');
    const workspace = statefulApi();
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const checkbox = screen.getByRole('checkbox', { name: /Remember session paths/u });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({ action: 'set-remember-paths', enabled: false }),
    );
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it('stores an optional PuTTY executable path in advanced settings', async () => {
    await i18n.changeLanguage('en');
    const workspace = statefulApi();
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const input = screen.getByLabelText('PuTTY executable path (Windows)');
    fireEvent.change(input, { target: { value: 'C:\\Tools\\PuTTY\\putty.exe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save terminal setting' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'set-putty-path',
        path: 'C:\\Tools\\PuTTY\\putty.exe',
      }),
    );
  });

  it('configures GitHub update automation and starts a manual check', async () => {
    const workspace = statefulApi({
      updateSettings: defaultUpdateSettings,
      updateState: {
        supported: true,
        currentVersion: '0.3.0',
        availableVersion: null,
        status: 'idle',
        progress: null,
        errorKey: null,
      },
    });
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
    expect(screen.getByText('Current version: 0.3.0')).toBeTruthy();
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Automatically check for updates',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Automatically download available updates',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole('checkbox', {
          name: /^Automatically install downloaded updates on exit/u,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Automatically download available updates' }),
    );
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'set-update-settings',
        settings: { ...defaultUpdateSettings, automaticDownload: true },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(workspace).toHaveBeenCalledWith({ action: 'check-for-updates' }));
  });

  it('opens update settings from the available-update toolbar icon', async () => {
    const workspace = statefulApi({
      updateSettings: defaultUpdateSettings,
      updateState: {
        supported: true,
        currentVersion: '0.3.0',
        availableVersion: '0.4.0',
        status: 'available',
        progress: null,
        errorKey: null,
      },
    });
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'OpenSCP 0.4.0 is available. Open update settings.',
      }),
    );

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Updates' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(workspace).toHaveBeenCalled();
  });

  it('stores an optional external editor executable path in advanced settings', async () => {
    await i18n.changeLanguage('en');
    const workspace = statefulApi();
    const selectedEditorPath = 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe';
    render(<App />);
    await pane('left').findByRole('row', { name: 'notes.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const input = screen.getByLabelText('Editor application or executable path');
    fireEvent.change(input, { target: { value: 'C:\\Tools\\Editor\\editor.exe' } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect((input as HTMLInputElement).value).toBe('C:\\Tools\\Editor\\editor.exe');
    fireEvent.click(screen.getByRole('button', { name: 'Choose editor' }));
    await waitFor(() => expect(workspace).toHaveBeenCalledWith({ action: 'pick-editor' }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(selectedEditorPath));
    fireEvent.click(screen.getByRole('button', { name: 'Save editor setting' }));
    await waitFor(() =>
      expect(workspace).toHaveBeenCalledWith({
        action: 'set-editor-path',
        path: selectedEditorPath,
      }),
    );
  });
});
