import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalDirectoryListing } from '@shared/ipc/contracts';
import type { Appearance, WorkspaceResult, WorkspaceSnapshot } from '@shared/ipc/workspace';
import { parseS3Path, s3Child } from '@shared/models/s3-path';
import {
  CommanderSurface,
  CommandButtons,
  fileCommandShortcut,
  type FileCommand,
} from './CommanderSurface';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { SourcePicker } from './SourcePicker';
import { VirtualFileList } from './VirtualFileList';
import type { WorkspaceRunner } from './useWorkspaceService';
import { readFileDrop } from './file-drop';
import {
  copyRequest,
  directoryName,
  type FileTransferRequest,
  type PaneLocation,
  type PaneSide,
} from './workspace-layout';

const localFallbackPaths = (path: string): string[] => {
  const candidates: string[] = [];
  let current = path;
  while (true) {
    const withoutTrailingSeparator = current.replace(/[\\/]+$/u, '');
    const separatorIndex = Math.max(
      withoutTrailingSeparator.lastIndexOf('\\'),
      withoutTrailingSeparator.lastIndexOf('/'),
    );
    let parent = withoutTrailingSeparator.slice(0, separatorIndex);
    if (/^[A-Za-z]:$/u.test(parent)) parent += '\\';
    else if (!parent && current.startsWith('/')) parent = '/';
    if (!parent || parent === current || candidates.includes(parent)) break;
    candidates.push(parent);
    current = parent;
  }
  return candidates;
};

export const FilePane = ({
  paneId,
  side,
  active,
  isActive,
  initialPath,
  initialized,
  snapshot,
  run,
  errorKey,
  appearance,
  destination,
  destinationId,
  isConnecting,
  onConnect,
  onActivate,
  onLocation,
}: {
  readonly paneId: string;
  readonly side: PaneSide;
  readonly active: boolean;
  readonly isActive: boolean;
  readonly initialPath: string | null;
  readonly initialized: boolean;
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly errorKey: string | null;
  readonly appearance: Appearance;
  readonly destination: PaneLocation | undefined;
  readonly destinationId: string;
  readonly isConnecting: boolean;
  readonly onConnect: (id: string) => void;
  readonly onActivate: () => void;
  readonly onLocation: (side: PaneSide, location: PaneLocation) => void;
}) => {
  const { t } = useTranslation();
  const session = snapshot.sessions.find((item) => item.workspaceId === paneId);
  const kind = session?.kind ?? (session ? 'sftp' : 'local');
  const ready = kind === 'local' || session?.state === 'connected';
  const isS3 = kind === 's3';
  const [listing, setListing] = useState<LocalDirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pathFallback, setPathFallback] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [operation, setOperation] = useState<'mkdir' | 'rename' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [deletions, setDeletions] = useState<Record<
    string,
    NonNullable<WorkspaceResult['deletion']>
  > | null>(null);
  const version = useRef(0);
  const operationVersion = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const initialPathReference = useRef(initialPath);
  const hasSuccessfulListing = useRef(false);
  const attemptedPath = useRef<string | null>(initialPathReference.current);
  const shouldRestoreFileFocus = useRef(false);
  const load = useCallback(
    async (path: string | null) => {
      shouldRestoreFileFocus.current =
        panel.current?.querySelector('.file-list-shell')?.contains(document.activeElement) ?? false;
      attemptedPath.current = path;
      const request = ++version.current;
      setLoading(true);
      setLoadError(null);
      setPathFallback(false);
      if (kind === 'local') {
        const result = await window.desktop.listLocalDirectory(path);
        if (request !== version.current) return;
        if (result.ok) {
          setListing(result.data);
          setSelection([]);
          hasSuccessfulListing.current = true;
          await run({
            action: 'remember-local-path',
            workspaceId: paneId,
            path: result.data.currentPath,
          });
        } else if (
          path !== null &&
          path === initialPathReference.current &&
          !hasSuccessfulListing.current
        ) {
          let fallback: Awaited<ReturnType<typeof window.desktop.listLocalDirectory>> | undefined;
          for (const candidate of [...localFallbackPaths(path), null]) {
            fallback = await window.desktop.listLocalDirectory(candidate);
            if (fallback.ok) break;
          }
          if (request !== version.current) return;
          if (fallback?.ok) {
            setListing(fallback.data);
            setSelection([]);
            setPathFallback(true);
            hasSuccessfulListing.current = true;
            await run({
              action: 'remember-local-path',
              workspaceId: paneId,
              path: fallback.data.currentPath,
            });
          } else setLoadError(result.error.messageKey);
        } else setLoadError(result.error.messageKey);
      } else {
        const result = await run({ action: 'list', workspaceId: paneId, path });
        if (request !== version.current) return;
        if (result?.listing) {
          setListing(result.listing);
          setSelection([]);
        } else setLoadError('errors.provider.io');
      }
      setLoading(false);
    },
    [kind, run, paneId],
  );
  useEffect(() => {
    if (!hasSuccessfulListing.current) initialPathReference.current = initialPath;
  }, [initialPath]);
  useEffect(() => {
    setListing(null);
    setSelection([]);
    if (!initialized) setLoading(true);
    else if (ready) void load(kind === 'local' ? initialPathReference.current : null);
    else setLoading(false);
    return () => {
      version.current++;
    };
  }, [load, ready, kind, initialized]);
  const completed = snapshot.transfers
    .filter((transfer) => transfer.state === 'completed')
    .map((transfer) => transfer.id)
    .join(',');
  const previousCompleted = useRef(completed);
  useEffect(() => {
    if (previousCompleted.current !== completed && !operation) {
      previousCompleted.current = completed;
      if (listing && ready) void load(listing.currentPath);
    }
  }, [completed, listing, load, ready, operation]);
  const currentPath = listing?.currentPath ?? session?.currentPath ?? initialPath ?? '';
  const isBucketList = isS3 && !!listing && !parseS3Path(listing.currentPath).bucket;
  const writable = kind === 'local' || (session?.capabilities?.write === true && !isBucketList);
  const title = session?.name ?? directoryName(currentPath);
  useEffect(() => {
    onLocation(side, {
      kind,
      path: currentPath,
      title,
      ready: ready && !!listing && !loading,
      writable,
    });
  }, [side, kind, currentPath, title, ready, listing, loading, writable, onLocation]);
  const entries =
    listing?.entries.filter((entry) => appearance.showHidden || !entry.name.startsWith('.')) ?? [];
  useLayoutEffect(() => {
    if (loading || !shouldRestoreFileFocus.current) return;
    shouldRestoreFileFocus.current = false;
    if (
      panel.current?.dataset.active !== 'true' ||
      (document.activeElement !== null && document.activeElement !== document.body)
    )
      return;
    const focusTarget =
      panel.current.querySelector<HTMLElement>('[data-testid="file-row"][tabindex="0"]') ??
      panel.current.querySelector<HTMLElement>('.commander-surface');
    focusTarget?.focus();
  }, [currentPath, entries.length, loading]);
  const selected = selection.filter((path) => entries.some((entry) => entry.path === path));
  const selectedEntry = entries.find((entry) => entry.path === selected[0]);
  const invalidSelection =
    !selected.length ||
    entries.some((entry) => selected.includes(entry.path) && entry.s3Kind === 'bucket');
  const closeOperation = () => {
    if (!busy) {
      operationVersion.current++;
      setOperation(null);
    }
  };
  const begin = (next: 'mkdir' | 'rename' | 'delete') => {
    const request = ++operationVersion.current;
    setOperation(next);
    setDeletions(null);
    if (next === 'delete' && isS3)
      void (async () => {
        const previews: Record<string, NonNullable<WorkspaceResult['deletion']>> = {};
        for (const path of selected) {
          const result = await run({ action: 'preview-delete', workspaceId: paneId, path });
          if (request !== operationVersion.current || !result?.deletion) return;
          previews[path] = result.deletion;
        }
        setDeletions(previews);
      })();
  };
  const queueCopy = (requests: FileTransferRequest[]) => {
    void (async () => {
      for (const request of requests) if (!(await run(request))) return;
    })();
  };
  const commands: FileCommand[] = [
    {
      id: 'mkdir',
      label: t('operations.mkdir'),
      key: 'F7',
      disabled:
        !listing ||
        !ready ||
        busy ||
        loading ||
        (kind !== 'local' && (!session?.capabilities?.createDirectory || isBucketList)),
      run: () => begin('mkdir'),
    },
    {
      id: 'copy',
      label: t('ui.copyTo', { path: destination?.path || t('ui.sourceNotReady') }),
      key: 'F5',
      disabled:
        invalidSelection ||
        !ready ||
        busy ||
        loading ||
        !destination?.ready ||
        !destination.writable ||
        (kind !== 'local' && !session?.capabilities?.read),
      run: () => {
        if (destination)
          queueCopy(
            selected.map((path) => copyRequest(paneId, kind, path, destinationId, destination)),
          );
      },
    },
    {
      id: 'rename',
      label: t('operations.rename'),
      key: 'F2',
      disabled:
        invalidSelection ||
        selected.length !== 1 ||
        !ready ||
        busy ||
        loading ||
        (kind !== 'local' && !session?.capabilities?.rename),
      run: () => begin('rename'),
    },
    {
      id: 'edit',
      label: t('operations.edit'),
      key: 'F4',
      disabled:
        selected.length !== 1 ||
        selectedEntry?.kind !== 'file' ||
        !ready ||
        busy ||
        loading ||
        (kind !== 'local' &&
          (!session?.capabilities?.read || !session.capabilities.write || isBucketList)),
      run: () => {
        const path = selected[0];
        if (path) void run({ action: 'edit-file', workspaceId: paneId, path });
      },
    },
    {
      id: 'delete',
      label: t('operations.delete'),
      key: 'Delete',
      disabled:
        invalidSelection ||
        !ready ||
        busy ||
        loading ||
        (kind !== 'local' && !session?.capabilities?.delete),
      run: () => begin('delete'),
    },
    {
      id: 'refresh',
      label: t('commander.refresh'),
      key: 'F5',
      ctrlKey: true,
      disabled: !ready || loading,
      run: () => void load(listing?.currentPath ?? null),
    },
    {
      id: 'up',
      label: t('commander.up'),
      key: 'Backspace',
      disabled: !listing?.parentPath || loading,
      run: () => {
        if (listing?.parentPath) void load(listing.parentPath);
      },
    },
  ];
  if (kind === 'sftp' && session?.state === 'connected')
    commands.push({
      id: 'terminal',
      label: t('terminal.open'),
      run: () => void run({ action: 'open-ssh-terminal', workspaceId: paneId }),
    });
  const retry = () => {
    if (session)
      void run({ action: 'connect', workspaceId: paneId, profileId: session.profileId }).then(
        (result) => {
          if (result) void load(null);
        },
      );
  };
  const hostProfile = snapshot.profiles.find((profile) => profile.id === session?.profileId);
  const refreshCommand = commands.find((command) => command.id === 'refresh');
  const refreshShortcut = refreshCommand ? fileCommandShortcut(refreshCommand) : undefined;
  return (
    <section
      ref={panel}
      className="panel"
      aria-label={t(`ui.${side}`)}
      data-testid={`${side}-panel`}
      data-active={active}
      tabIndex={-1}
      onFocus={onActivate}
      onPointerDown={onActivate}
    >
      <CommanderSurface
        commands={commands}
        onDrop={(event) => {
          const payload = readFileDrop(event);
          if (!payload || !listing || !ready || !writable) return;
          queueCopy(
            payload.paths.map((path) =>
              copyRequest(
                payload.workspaceId,
                payload.side === 'local' ? 'local' : 'sftp',
                path,
                paneId,
                { kind, path: listing.currentPath, title, ready, writable },
              ),
            ),
          );
        }}
      >
        <div className="panel__header">
          <SourcePicker
            snapshot={snapshot}
            session={session}
            rootPath={kind === 'local' ? listing?.breadcrumbs[0]?.path : undefined}
            isActive={isActive}
            isConnecting={isConnecting}
            onNavigate={(path) => void load(path)}
            onConnect={onConnect}
          />
          <span className="source-state">
            {kind === 'local'
              ? t('ui.local')
              : `${kind.toUpperCase()} · ${t(
                  session?.connectionStage
                    ? `connections.stages.${session.connectionStage}`
                    : `connections.states.${session?.state}`,
                )}`}
          </span>
        </div>
        <div className="pathbar">
          <button
            className="icon-button"
            aria-label={t('path.up')}
            title={t('path.up')}
            disabled={!listing?.parentPath || loading}
            onClick={() => {
              if (listing?.parentPath) void load(listing.parentPath);
            }}
          >
            <Icon name="ArrowUp" />
          </button>
          <button
            className="icon-button"
            aria-label={t('toolbar.refresh')}
            title={
              refreshShortcut
                ? `${t('toolbar.refresh')} (${refreshShortcut})`
                : t('toolbar.refresh')
            }
            disabled={!ready || loading}
            onClick={() => void load(listing?.currentPath ?? null)}
          >
            <Icon name="RefreshCw" />
          </button>
          <form
            key={currentPath}
            className="address-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && pathInput.current?.value) void load(pathInput.current.value);
            }}
          >
            <input
              ref={pathInput}
              aria-label={t('ui.editPath')}
              defaultValue={currentPath}
              disabled={!ready}
              title={currentPath}
              spellCheck={false}
            />
          </form>
        </div>
        <div className="panel-actions">
          <CommandButtons commands={commands} />
          <span className="selection-summary">{t('ui.selection', { count: selected.length })}</span>
        </div>
        {loadError ? (
          <div className="inline-error" role="alert">
            {t(loadError)}
            <button onClick={() => void load(attemptedPath.current)}>{t('toolbar.retry')}</button>
            {listing ? (
              <button onClick={() => setLoadError(null)}>{t('toolbar.back')}</button>
            ) : null}
          </div>
        ) : null}
        {session?.pathFallback && !loadError ? (
          <div className="inline-notice" role="status">
            {t('path.restoredFallback')}
          </div>
        ) : null}
        {pathFallback && !loadError ? (
          <div className="inline-notice" role="status">
            {t('path.restoredFallback')}
          </div>
        ) : null}
        {session?.hostKey ? (
          <div className="host-key" role="alert">
            <code>
              {hostProfile?.kind === 'sftp' ? `${hostProfile.host}:${hostProfile.port}` : ''}
            </code>
            <strong>
              {t(session.hostKey.changed ? 'connections.changedKey' : 'connections.unknownKey')}
            </strong>
            <code>{session.hostKey.fingerprint}</code>
            {!session.hostKey.changed ? (
              <button
                onClick={() =>
                  void run({
                    action: 'trust-host',
                    workspaceId: paneId,
                    fingerprint: session.hostKey?.fingerprint ?? '',
                  }).then((result) => {
                    if (result) retry();
                  })
                }
              >
                {t('connections.trust')}
              </button>
            ) : null}
          </div>
        ) : null}
        {session && session.state !== 'connected' && !session.hostKey ? (
          <div className="panel-state" role="status">
            <Icon name={isS3 ? 'Database' : 'ShieldCheck'} />
            {session.state === 'connecting' ? (
              <progress aria-label={t('connections.progress')} />
            ) : null}
            <strong>
              {t(
                session.connectionStage
                  ? `connections.stages.${session.connectionStage}`
                  : `connections.states.${session.state}`,
              )}
            </strong>
            {session.connectionErrorKey ? (
              <span className="inline-error">{t(session.connectionErrorKey)}</span>
            ) : null}
            {session.state === 'connecting' ? (
              <button
                disabled={passwordBusy}
                onClick={() => void run({ action: 'cancel-connect', workspaceId: paneId })}
              >
                {t('connections.cancelConnect')}
              </button>
            ) : null}
            {session.state === 'failed' || session.state === 'disconnected' ? (
              <button onClick={retry}>{t('ui.reconnect')}</button>
            ) : null}
            <span>{t('ui.locked')}</span>
          </div>
        ) : null}
        {(snapshot.cleanups ?? [])
          .filter((cleanup) => cleanup.profileId === session?.profileId)
          .map((cleanup) => (
            <div role="alert" className="inline-error" key={cleanup.profileId}>
              {t('s3.cleanupPending', { count: cleanup.count, name: title })}
              <button
                onClick={() =>
                  void run({ action: 'cleanup-multipart', profileId: cleanup.profileId })
                }
              >
                {t('s3.cleanup')}
              </button>
            </div>
          ))}
        {loading || (isConnecting && !session) ? (
          <div className="panel-state" role="status">
            <span className="spinner" />
            {t('fileList.loading')}
          </div>
        ) : ready && listing ? (
          entries.length ? (
            <VirtualFileList
              key={`${kind}:${currentPath}`}
              entries={entries}
              selectedPaths={selected}
              onSelectionChange={setSelection}
              onOpenDirectory={(path) => void load(path)}
              {...(kind === 'local'
                ? {
                    onOpenFile: (path: string) =>
                      void run({ action: 'open-local-file', workspaceId: paneId, path }),
                  }
                : {})}
              dragSource={{ workspaceId: paneId, side: kind === 'local' ? 'local' : 'remote' }}
              rowHeight={appearance.density === 'compact' ? 30 : 38}
            />
          ) : (
            <div className="panel-state">{t('fileList.empty')}</div>
          )
        ) : null}
        <footer className="panel-footer">
          <span>{t('status.items', { count: entries.length })}</span>
          <span>
            {selected.length === 1
              ? selectedEntry?.name
              : t('ui.selection', { count: selected.length })}
          </span>
        </footer>
      </CommanderSurface>
      {session?.passwordRequired ? (
        <Dialog
          title={t('connections.passwordPromptTitle')}
          onClose={() => {
            if (!passwordBusy) void run({ action: 'cancel-connect', workspaceId: paneId });
          }}
        >
          <p>{t('connections.passwordPromptHint', { name: session.name })}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (passwordBusy) return;
              const form = event.currentTarget;
              const data = new FormData(form);
              const password = String(data.get('password') ?? '');
              const save = data.get('save') === 'on';
              if (!password) return;
              form.reset();
              setPasswordBusy(true);
              void run({
                action: 'provide-password',
                workspaceId: paneId,
                password,
                save,
              }).finally(() => setPasswordBusy(false));
            }}
          >
            <label>
              {t('connections.password')}
              <input
                autoFocus
                autoComplete="current-password"
                disabled={passwordBusy}
                maxLength={65536}
                name="password"
                required
                type="password"
              />
            </label>
            <label className="checkbox-label">
              <input disabled={passwordBusy} name="save" type="checkbox" />
              <span>{t('connections.savePassword')}</span>
            </label>
            {errorKey ? (
              <p role="alert" className="inline-error">
                {t(errorKey)}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                disabled={passwordBusy}
                type="button"
                onClick={() => void run({ action: 'cancel-connect', workspaceId: paneId })}
              >
                {t('connections.cancel')}
              </button>
              <button className="primary" disabled={passwordBusy}>
                {t(passwordBusy ? 'ui.working' : 'connections.submitPassword')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {operation ? (
        <Dialog title={t(`operations.${operation}`)} onClose={closeOperation}>
          {operation === 'rename' && isS3 ? (
            <p className="inline-error">{t('s3.renameWarning')}</p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const name = String(new FormData(event.currentTarget).get('name') ?? '');
              setBusy(true);
              void (async () => {
                if (listing) {
                  const separator =
                    kind === 'local' && listing.currentPath.includes('\\') ? '\\' : '/';
                  const destinationPath = isS3
                    ? s3Child(
                        listing.currentPath,
                        name,
                        operation === 'mkdir' || selectedEntry?.s3Kind === 'prefix',
                      )
                    : `${listing.currentPath.replace(/[\\/]$/u, '')}${separator}${name}`;
                  const paths = operation === 'mkdir' ? [destinationPath] : selected;
                  for (const path of paths) {
                    const result =
                      kind === 'local'
                        ? await run({
                            action: 'local-operation',
                            workspaceId: paneId,
                            operation,
                            path,
                            ...(operation === 'rename' ? { destinationPath } : {}),
                          })
                        : operation === 'mkdir'
                          ? await run({ action: 'mkdir', workspaceId: paneId, path })
                          : operation === 'rename'
                            ? await run({
                                action: 'rename',
                                workspaceId: paneId,
                                path,
                                destinationPath,
                              })
                            : await run({
                                action: 'delete',
                                workspaceId: paneId,
                                path,
                                recursive: true,
                                ...(deletions?.[path]
                                  ? { confirmationId: deletions[path].confirmationId }
                                  : {}),
                              });
                    if (!result) return;
                  }
                  await load(listing.currentPath);
                }
                setOperation(null);
              })().finally(() => setBusy(false));
            }}
          >
            {operation === 'delete' ? (
              <>
                <p>{t('commander.deleteSelection')}</p>
                <ul className="operation-selection">
                  {selected.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                {isS3 ? (
                  <p>
                    {t('s3.deleteWarning')}{' '}
                    {deletions
                      ? t('s3.deleteSummary', {
                          count: Object.values(deletions).reduce(
                            (sum, item) => sum + item.count,
                            0,
                          ),
                          bytes: Object.values(deletions)
                            .reduce((sum, item) => sum + item.bytes, 0n)
                            .toString(),
                        })
                      : t('s3.calculating')}
                  </p>
                ) : null}
              </>
            ) : (
              <label>
                {t('operations.name')}
                <input
                  name="name"
                  required
                  autoFocus
                  pattern={'[^\\x2f\\x5c]+'}
                  defaultValue={operation === 'rename' ? selectedEntry?.name : ''}
                />
              </label>
            )}
            {errorKey ? (
              <p role="alert" className="inline-error">
                {t(errorKey)}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={closeOperation}>
                {t('connections.cancel')}
              </button>
              <button
                className={operation === 'delete' ? 'destructive' : 'primary'}
                disabled={busy || (operation === 'delete' && isS3 && !deletions)}
              >
                {t(busy ? 'ui.working' : 'operations.confirm')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
};
