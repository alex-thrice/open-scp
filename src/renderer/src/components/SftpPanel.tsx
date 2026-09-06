import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  RemoteDirectoryListing,
  WorkspaceSnapshot,
  WorkspaceResult,
  WorkspaceRequest,
} from '@shared/ipc/workspace';
import { parseS3Path, s3Child } from '@shared/models/s3-path';
import { S3ConnectionForm } from './S3ConnectionForm';
import { ConnectionForm } from './ConnectionForm';
import { PathBreadcrumbs } from './PathBreadcrumbs';
import { VirtualFileList } from './VirtualFileList';
import type { WorkspaceRunner } from './useWorkspaceService';
import { CommanderSurface, CommandButtons, type FileCommand } from './CommanderSurface';
import { Dialog } from './Dialog';
import { readFileDrop } from './file-drop';

export const SftpPanel = ({
  workspaceId,
  snapshot,
  run,
  localPath,
  localSelection,
  localSelections,
  errorKey,
}: {
  readonly workspaceId: string;
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly localPath: string | undefined;
  readonly localSelection: string | null;
  readonly localSelections: readonly string[];
  readonly errorKey: string | null;
}) => {
  const { t } = useTranslation();
  const [profileId, setProfileId] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [newKind, setNewKind] = useState<'sftp' | 's3'>('sftp');
  const [operation, setOperation] = useState<'mkdir' | 'rename' | 'copy' | 'delete' | null>(null);
  const [deletion, setDeletion] = useState<WorkspaceResult['deletion']>();
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [remoteTransfer, setRemoteTransfer] = useState(false);
  const [destinationId, setDestinationId] = useState('');
  const [pendingTransfers, setPendingTransfers] = useState<WorkspaceRequest[]>([]);
  const [deletions, setDeletions] = useState<
    Record<string, NonNullable<WorkspaceResult['deletion']>>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [conflictPolicy, setConflictPolicy] = useState<'ask' | 'overwrite' | 'skip' | 'rename'>(
    'ask',
  );
  const requestVersion = useRef(0);
  const session = snapshot.sessions.find((item) => item.workspaceId === workspaceId);
  const profiles = snapshot.profiles;
  const isS3 = session?.kind === 's3';
  const selectedEntry = listing?.entries.find((entry) => entry.path === selected);
  const isBucketList = isS3 && listing && !parseS3Path(listing.currentPath).bucket;
  const selectedProfile = profiles.find(
    (profile) => profile.id === (profileId || session?.profileId || profiles[0]?.id),
  );
  const load = useCallback(
    async (path: string | null) => {
      const version = ++requestVersion.current;
      setIsLoading(true);
      const result = await run({ action: 'list', workspaceId, path });
      if (version !== requestVersion.current) return;
      setIsLoading(false);
      if (result?.listing) {
        setListing(result.listing);
        setSelected(null);
        setSelectedPaths([]);
      }
    },
    [run, workspaceId],
  );
  const completedUploads = snapshot.transfers
    .filter(
      (item) =>
        (item.workspaceId === workspaceId || item.destinationWorkspaceId === workspaceId) &&
        (item.direction === 'upload' || item.direction === 'remote') &&
        item.state === 'completed',
    )
    .map((item) => item.id)
    .join(',');
  const previousUploads = useRef('');
  useEffect(() => {
    if (completedUploads !== previousUploads.current) {
      previousUploads.current = completedUploads;
      if (listing && session?.state === 'connected') void load(listing.currentPath);
    }
  }, [completedUploads, listing, session?.state, load]);
  const connect = async () => {
    if (selectedProfile) {
      const result = await run({ action: 'connect', workspaceId, profileId: selectedProfile.id });
      if (result) await load(null);
    }
  };
  useEffect(() => {
    if (session?.state !== 'connected') {
      requestVersion.current += 1;
      setListing(null);
      setSelected(null);
      setIsLoading(false);
    }
  }, [session?.state]);
  const enqueue = async (requests: WorkspaceRequest[]) => {
    for (const request of requests) if (!(await run(request))) break;
  };
  const queue = (requests: WorkspaceRequest[]) => {
    if (conflictPolicy === 'overwrite') setPendingTransfers(requests);
    else void enqueue(requests);
  };
  const transfer = (direction: 'upload' | 'download') => {
    const paths = direction === 'upload' ? localSelections : selectedPaths;
    const destinationDirectory = direction === 'upload' ? listing?.currentPath : localPath;
    if (paths.length && destinationDirectory)
      queue(
        paths.map((sourcePath) => ({
          action: 'transfer',
          workspaceId,
          direction,
          sourcePath,
          destinationDirectory,
          conflictPolicy,
        })),
      );
  };
  const beginOperation = (next: 'mkdir' | 'rename' | 'copy' | 'delete') => {
    setOperation(next);
    setDeletion(undefined);
    setDeletions({});
    if (next === 'delete' && isS3)
      void (async () => {
        const results: Record<string, NonNullable<WorkspaceResult['deletion']>> = {};
        for (const path of selectedPaths) {
          const result = await run({ action: 'preview-delete', workspaceId, path });
          if (!result?.deletion) return;
          results[path] = result.deletion;
        }
        setDeletions(results);
        setDeletion({
          confirmationId: Object.values(results)[0]?.confirmationId ?? '',
          count: Object.values(results).reduce((sum, item) => sum + item.count, 0),
          bytes: Object.values(results).reduce((sum, item) => sum + item.bytes, 0n),
        });
      })();
  };
  const caps = session?.capabilities;
  const invalidSelection =
    !selectedPaths.length ||
    listing?.entries.some(
      (entry) => selectedPaths.includes(entry.path) && entry.s3Kind === 'bucket',
    );
  const commands: FileCommand[] =
    listing && session?.state === 'connected'
      ? [
          ...(caps?.createDirectory
            ? [
                {
                  id: 'mkdir',
                  label: t('operations.mkdir'),
                  key: 'F7',
                  disabled: !!isBucketList,
                  run: () => beginOperation('mkdir'),
                },
              ]
            : []),
          ...(caps?.rename
            ? [
                {
                  id: 'rename',
                  label: t('operations.rename'),
                  key: 'F2',
                  disabled: !!invalidSelection || selectedPaths.length !== 1,
                  run: () => beginOperation('rename'),
                },
              ]
            : []),
          ...(caps?.serverSideCopy
            ? [
                {
                  id: 'copy',
                  label: t('operations.copy'),
                  disabled: !!invalidSelection || selectedPaths.length !== 1,
                  run: () => beginOperation('copy'),
                },
              ]
            : []),
          ...(caps?.delete
            ? [
                {
                  id: 'delete',
                  label: t('operations.delete'),
                  key: 'Delete',
                  disabled: !!invalidSelection,
                  run: () => beginOperation('delete'),
                },
              ]
            : []),
          ...(caps?.read
            ? [
                {
                  id: 'download',
                  label: t('transfers.download'),
                  key: 'F5',
                  disabled: !!invalidSelection || !localPath,
                  run: () => transfer('download'),
                },
              ]
            : []),
          {
            id: 'refresh',
            label: t('commander.refresh'),
            key: 'F5',
            ctrlKey: true,
            run: () => void load(listing.currentPath),
          },
          {
            id: 'up',
            label: t('commander.up'),
            key: 'Backspace',
            disabled: !listing.parentPath,
            run: () => void load(listing.parentPath),
          },
        ]
      : [];
  const pendingKey = session?.hostKey;
  const hostProfile = profiles.find((profile) => profile.id === session?.profileId);
  return (
    <CommanderSurface
      commands={commands}
      onDrop={(event) => {
        const payload = readFileDrop(event);
        if (!payload || !listing || session?.state !== 'connected' || isBucketList || !caps?.write)
          return;
        void enqueue(
          payload.paths.map((sourcePath): WorkspaceRequest =>
            payload.side === 'local'
              ? {
                  action: 'transfer',
                  workspaceId,
                  direction: 'upload',
                  sourcePath,
                  destinationDirectory: listing.currentPath,
                  conflictPolicy: 'ask',
                }
              : {
                  action: 'remote-transfer',
                  workspaceId: payload.workspaceId,
                  destinationWorkspaceId: workspaceId,
                  sourcePath,
                  destinationDirectory: listing.currentPath,
                  conflictPolicy: 'ask',
                },
          ),
        );
      }}
    >
      <div className="remote-controls">
        <select
          aria-label={t('s3.selector')}
          value={selectedProfile?.id ?? ''}
          onChange={(event) => setProfileId(event.currentTarget.value)}
        >
          <option value="" disabled>
            {t('connections.choose')}
          </option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.kind.toUpperCase()} · {profile.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setIsNew(true);
            setNewKind('sftp');
            setIsEditing(true);
          }}
        >
          {t('connections.new')}
        </button>
        <button
          onClick={() => {
            setIsNew(true);
            setNewKind('s3');
            setIsEditing(true);
          }}
        >
          {t('s3.new')}
        </button>
        <button
          disabled={!selectedProfile}
          onClick={() => {
            setIsNew(false);
            setIsEditing(true);
          }}
        >
          {t('connections.edit')}
        </button>
        <button
          disabled={!selectedProfile || session?.state === 'connecting'}
          onClick={() => void connect()}
        >
          {t(session?.state === 'failed' ? 'connections.reconnect' : 'connections.connect')}
        </button>
        {session?.state === 'connected' ? (
          <button onClick={() => void run({ action: 'disconnect', workspaceId })}>
            {t('connections.disconnect')}
          </button>
        ) : null}
        <span className="connection-state">
          {session
            ? `${session.name} · ${t(`connections.states.${session.state}`)}`
            : t('remotePanel.subtitle')}
        </span>
      </div>
      {errorKey ? (
        <div className="inline-error" role="alert">
          {t(errorKey)}
        </div>
      ) : null}
      {(snapshot.cleanups ?? []).map((item) => (
        <div className="inline-error" role="alert" key={item.profileId}>
          {t('s3.cleanupPending', {
            count: item.count,
            name: profiles.find((profile) => profile.id === item.profileId)?.name ?? '',
          })}
          <button
            onClick={() => void run({ action: 'cleanup-multipart', profileId: item.profileId })}
          >
            {t('s3.cleanup')}
          </button>
        </div>
      ))}
      {pendingKey ? (
        <div className="host-key" role="alert">
          <code>
            {hostProfile?.kind === 'sftp' ? `${hostProfile.host}:${hostProfile.port}` : ''}
          </code>
          <strong>
            {t(pendingKey.changed ? 'connections.changedKey' : 'connections.unknownKey')}
          </strong>
          <code>{pendingKey.fingerprint}</code>
          {!pendingKey.changed ? (
            <button
              onClick={() =>
                void run({
                  action: 'trust-host',
                  workspaceId,
                  fingerprint: pendingKey.fingerprint,
                }).then((result) => {
                  if (result && session)
                    void run({ action: 'connect', workspaceId, profileId: session.profileId }).then(
                      (connected) => {
                        if (connected) void load(null);
                      },
                    );
                })
              }
            >
              {t('connections.trust')}
            </button>
          ) : null}
        </div>
      ) : null}
      {listing && session?.state === 'connected' ? (
        <>
          <div className="pathbar">
            <PathBreadcrumbs
              breadcrumbs={listing.breadcrumbs}
              parentPath={listing.parentPath}
              onNavigate={(path) => void load(path)}
              onNavigateUp={() => void load(listing.parentPath)}
              onRefresh={() => void load(listing.currentPath)}
            />
          </div>
          <form
            className="path-entry"
            key={listing.currentPath}
            onSubmit={(event) => {
              event.preventDefault();
              void load(String(new FormData(event.currentTarget).get('path')));
            }}
          >
            <input
              aria-label={t('commander.path')}
              name="path"
              defaultValue={listing.currentPath}
              required
            />
            <button>{t('commander.go')}</button>
            <select
              aria-label={t('library.recent')}
              value=""
              onChange={(event) => void load(event.currentTarget.value)}
            >
              <option value="" disabled>
                {t('library.recent')}
              </option>
              {(snapshot.recentPaths?.[session.profileId] ?? []).map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </form>
          <CommandButtons commands={commands} />
          <div className="remote-controls">
            {caps?.write ? (
              <button
                data-command="upload"
                disabled={!localSelection || !!isBucketList}
                onClick={() => transfer('upload')}
              >
                {t('transfers.upload')}
              </button>
            ) : null}
            {caps?.read ? (
              <button
                disabled={
                  !!invalidSelection ||
                  !snapshot.sessions.some(
                    (item) => item.workspaceId !== workspaceId && item.state === 'connected',
                  )
                }
                onClick={() => setRemoteTransfer(true)}
              >
                {t('commander.remote')}
              </button>
            ) : null}
            <select
              aria-label={t('transfers.conflictPolicy')}
              value={conflictPolicy}
              onChange={(event) =>
                setConflictPolicy(event.currentTarget.value as typeof conflictPolicy)
              }
            >
              {(['ask', 'overwrite', 'skip', 'rename'] as const).map((policy) => (
                <option key={policy} value={policy}>
                  {t(`transfers.policies.${policy}`)}
                </option>
              ))}
            </select>
            <span className="selection-summary" role="status" title={t('commander.shortcuts')}>
              {t('commander.selected', { count: selectedPaths.length })}
            </span>
          </div>
          {isLoading ? (
            <div className="panel-state">{t('fileList.loading')}</div>
          ) : listing.entries.length === 0 ? (
            <div className="panel-state">{t('fileList.empty')}</div>
          ) : (
            <VirtualFileList
              entries={listing.entries}
              onOpenDirectory={(path) => void load(path)}
              onSelect={setSelected}
              selectedPath={selected}
              selectedPaths={selectedPaths}
              onSelectionChange={setSelectedPaths}
              dragSource={{ workspaceId, side: 'remote' }}
            />
          )}
        </>
      ) : (
        <div className="panel-state panel-state--disconnected">
          <span aria-hidden="true" className="connection-icon">
            ⌁
          </span>
          <strong>{t('remotePanel.disconnectedTitle')}</strong>
          <span>{t('remotePanel.disconnectedDescription')}</span>
        </div>
      )}
      {isEditing ? (
        (isNew ? newKind === 's3' : selectedProfile?.kind === 's3') ? (
          <S3ConnectionForm
            errorKey={errorKey}
            profile={!isNew && selectedProfile?.kind === 's3' ? selectedProfile : undefined}
            run={run}
            onClose={() => setIsEditing(false)}
          />
        ) : (
          <ConnectionForm
            errorKey={errorKey}
            profile={!isNew && selectedProfile?.kind === 'sftp' ? selectedProfile : undefined}
            run={run}
            onClose={() => setIsEditing(false)}
          />
        )
      ) : null}
      {remoteTransfer ? (
        <Dialog title={t('commander.remote')} onClose={() => setRemoteTransfer(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              queue(
                selectedPaths.map((sourcePath) => ({
                  action: 'remote-transfer',
                  workspaceId,
                  destinationWorkspaceId: String(data.get('workspace')),
                  sourcePath,
                  destinationDirectory: String(data.get('path')),
                  conflictPolicy,
                })),
              );
              setRemoteTransfer(false);
            }}
          >
            <label>
              {t('commander.destination')}
              <select
                name="workspace"
                required
                value={
                  destinationId ||
                  snapshot.sessions.find(
                    (item) => item.workspaceId !== workspaceId && item.state === 'connected',
                  )?.workspaceId ||
                  ''
                }
                onChange={(event) => setDestinationId(event.currentTarget.value)}
              >
                {snapshot.sessions
                  .filter((item) => item.workspaceId !== workspaceId && item.state === 'connected')
                  .map((item) => (
                    <option key={item.workspaceId} value={item.workspaceId}>
                      {item.kind?.toUpperCase()} · {item.name} · {item.workspaceId}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t('commander.destinationPath')}
              <input
                key={destinationId}
                name="path"
                required
                defaultValue={
                  (
                    snapshot.sessions.find((item) => item.workspaceId === destinationId) ??
                    snapshot.sessions.find(
                      (item) => item.workspaceId !== workspaceId && item.state === 'connected',
                    )
                  )?.currentPath ?? ''
                }
              />
            </label>
            <button>{t('commander.send')}</button>
            <button type="button" onClick={() => setRemoteTransfer(false)}>
              {t('connections.cancel')}
            </button>
          </form>
        </Dialog>
      ) : null}
      {pendingTransfers.length ? (
        <Dialog title={t('operations.confirm')} onClose={() => setPendingTransfers([])}>
          <p>{t('commander.overwrite')}</p>
          <button
            onClick={() => {
              void enqueue(pendingTransfers);
              setPendingTransfers([]);
            }}
          >
            {t('operations.confirm')}
          </button>
          <button onClick={() => setPendingTransfers([])}>{t('connections.cancel')}</button>
        </Dialog>
      ) : null}
      {operation && listing ? (
        <Dialog title={t(`operations.${operation}`)} onClose={() => setOperation(null)}>
          {isS3 && operation === 'rename' ? (
            <p className="inline-error">{t('s3.renameWarning')}</p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get('name') ?? '');
              const path = isS3
                ? s3Child(
                    listing.currentPath,
                    name,
                    operation === 'mkdir' || selectedEntry?.s3Kind === 'prefix',
                  )
                : `${listing.currentPath.replace(/\/$/u, '')}/${name}`;
              const request =
                operation === 'mkdir'
                  ? { action: 'mkdir' as const, workspaceId, path }
                  : operation === 'rename' || operation === 'copy'
                    ? {
                        action: operation,
                        workspaceId,
                        path: selected ?? '',
                        destinationPath: path,
                      }
                    : {
                        action: 'delete' as const,
                        workspaceId,
                        path: selected ?? '',
                        recursive: true,
                        ...(deletion ? { confirmationId: deletion.confirmationId } : {}),
                      };
              void (async () => {
                if (operation !== 'delete') return run(request);
                let result: WorkspaceResult | undefined;
                for (const path of selectedPaths) {
                  result = await run({
                    action: 'delete',
                    workspaceId,
                    path,
                    recursive: true,
                    ...(deletions[path] ? { confirmationId: deletions[path].confirmationId } : {}),
                  });
                  if (!result) return undefined;
                }
                return result;
              })().then((result) => {
                if (result) {
                  setOperation(null);
                  void load(listing.currentPath);
                }
              });
            }}
          >
            {operation === 'delete' ? (
              <p>
                {t('operations.deleteWarning')} {selectedPaths.join(', ')}
                {isS3 ? <span className="deletion-summary">{t('s3.deleteWarning')}</span> : null}
                {isS3 ? (
                  <strong className="deletion-summary">
                    {deletion
                      ? t('s3.deleteSummary', {
                          count: deletion.count,
                          bytes: deletion.bytes.toString(),
                        })
                      : t('s3.calculating')}
                  </strong>
                ) : null}
              </p>
            ) : (
              <label>
                {t('operations.name')}
                <input
                  autoFocus
                  name="name"
                  required
                  pattern="[^/\\\\]+"
                  defaultValue={
                    operation === 'rename' || operation === 'copy'
                      ? (selectedEntry?.name ?? '')
                      : ''
                  }
                />
              </label>
            )}
            {errorKey ? <div role="alert">{t(errorKey)}</div> : null}
            <div className="dialog-actions">
              <button type="submit" disabled={isS3 && operation === 'delete' && !deletion}>
                {t('operations.confirm')}
              </button>
              <button type="button" onClick={() => setOperation(null)}>
                {t('connections.cancel')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </CommanderSurface>
  );
};
