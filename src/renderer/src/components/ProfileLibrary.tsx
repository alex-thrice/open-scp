import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import { Dialog } from './Dialog';
import { ConnectionEditor } from './ConnectionEditor';
import { Icon } from './Icon';
import { protocolIcon } from './workspace-layout';
import type { WorkspaceRunner } from './useWorkspaceService';

export const ProfileLibrary = ({
  snapshot,
  run,
  errorKey,
  onClose,
  onOpen,
}: {
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly errorKey: string | null;
  readonly onClose: () => void;
  readonly onOpen: (profileId: string) => void;
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<string | null>(null);
  const [mode, setMode] = useState<'folder' | 'import' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [folderError, setFolderError] = useState(false);
  const folders = [
    ...new Set(
      [...(snapshot.profileFolders ?? []), ...Object.values(snapshot.profileGroups ?? {})].filter(
        Boolean,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const profile = snapshot.profiles.find((item) => item.id === editor);
  const close = () => {
    if (!busy) onClose();
  };
  const duplicate = async (id: string, name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await run({
        action: 'clone-profile',
        profileId: id,
        name: `${name} — ${t('library.copied')}`.slice(0, 200),
      });
      if (result?.savedProfileId) setEditor(result.savedProfileId);
    } finally {
      setBusy(false);
    }
  };
  if (editor !== null && (editor === 'new' || profile))
    return (
      <ConnectionEditor
        key={editor}
        profile={profile}
        snapshot={snapshot}
        run={run}
        errorKey={errorKey}
        onClose={() => setEditor(null)}
      />
    );
  return (
    <Dialog title={t('ui.connections')} onClose={close}>
      <section className="profile-library">
        <div className="section-heading">
          <h3>{t('ui.profiles')}</h3>
          <p>{t('ui.profilesHint')}</p>
        </div>
        <div className="library-toolbar">
          <div className="button-group" role="group" aria-label={t('ui.exportImport')}>
            <button
              disabled={busy}
              onClick={() => {
                setMode('import');
                setContent('');
                setSummary('');
              }}
            >
              <Icon name="FileInput" />
              {t('library.import')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void run({ action: 'save-export', kind: 'profiles' }).finally(() => setBusy(false));
              }}
            >
              <Icon name="FileOutput" />
              {t('library.export')}
            </button>
          </div>
          <div className="button-group" role="group" aria-label={t('ui.createGroup')}>
            <button className="primary" disabled={busy} onClick={() => setEditor('new')}>
              <Icon name="Plus" />
              {t('ui.newConnection')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setMode('folder');
                setFolderError(false);
              }}
            >
              <Icon name="FolderPlus" />
              {t('ui.folder')}
            </button>
          </div>
        </div>
        <p className="muted small">{t('library.archiveWarning')}</p>
        <label className="search-field">
          <Icon name="Search" />
          <input
            aria-label={t('library.search')}
            placeholder={t('ui.sourceSearch')}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        {mode === 'folder' ? (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
              if (
                !name ||
                /[\\/]/u.test(name) ||
                [...name].some((character) => character.charCodeAt(0) < 32) ||
                folders.some((folder) => folder.toLocaleLowerCase() === name.toLocaleLowerCase())
              ) {
                setFolderError(true);
                return;
              }
              setBusy(true);
              void run({ action: 'create-profile-folder', name })
                .then((result) => {
                  if (result) setMode(null);
                })
                .finally(() => setBusy(false));
            }}
          >
            <label>
              {t('ui.folderName')}
              <input autoFocus name="name" maxLength={100} required disabled={busy} />
            </label>
            {folderError ? (
              <p role="alert" className="inline-error">
                {t('ui.folderError')}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setMode(null)}>
                {t('ui.cancel')}
              </button>
              <button className="primary" disabled={busy}>
                {t('ui.create')}
              </button>
            </div>
          </form>
        ) : null}
        {mode === 'import' ? (
          <section className="inline-form">
            <label>
              {t('library.chooseFile')}
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  setContent('');
                  setSummary('');
                  if (!file) return;
                  if (file.size > 1048576) {
                    setSummary(t('library.validation'));
                    return;
                  }
                  void file
                    .text()
                    .then(setContent)
                    .catch(() => setSummary(t('library.validation')));
                }}
              />
            </label>
            <label>
              {t('library.content')}
              <textarea
                rows={5}
                maxLength={1048576}
                value={content}
                disabled={busy}
                onChange={(event) => setContent(event.currentTarget.value)}
              />
            </label>
            <div className="dialog-actions">
              <button disabled={busy} onClick={() => setMode(null)}>
                {t('ui.cancel')}
              </button>
              <button
                className="primary"
                disabled={busy || !content.trim()}
                onClick={() => {
                  setBusy(true);
                  void run({ action: 'import-profiles', content })
                    .then((result) => {
                      if (result?.importSummary) {
                        setSummary(t('library.summary', result.importSummary));
                        setContent('');
                        setMode(null);
                      }
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {t('library.importConfirm')}
              </button>
            </div>
          </section>
        ) : null}
        <div className="profile-groups">
          {[...folders, ''].map((folder) => {
            const items = snapshot.profiles.filter(
              (item) =>
                (snapshot.profileGroups?.[item.id] ?? '') === folder &&
                item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
            );
            if (!items.length && (search || !folder)) return null;
            return (
              <details className="profile-group" open key={folder}>
                <summary>
                  <Icon name="Folder" />
                  <span>{folder || t('ui.ungrouped')}</span>
                  <small>{items.length}</small>
                </summary>
                {items.length ? (
                  items.map((item) => (
                    <div className="profile-row" key={item.id}>
                      <span className="source-icon" data-kind={item.kind}>
                        <Icon name={protocolIcon(item.kind)} />
                      </span>
                      <button
                        className="profile-name"
                        aria-label={item.name}
                        disabled={busy}
                        onDoubleClick={() => onOpen(item.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            onOpen(item.id);
                          }
                        }}
                        title={t('ui.profilesHint')}
                      >
                        <strong>{item.name}</strong>
                        <small>
                          {item.kind === 'sftp'
                            ? `${item.username}@${item.host}`
                            : item.bucket || item.endpoint || item.region}
                        </small>
                      </button>
                      <span className="protocol-label">{item.kind.toUpperCase()}</span>
                      <button
                        className="icon-button"
                        disabled={busy}
                        title={t('connections.edit')}
                        aria-label={`${t('connections.edit')}: ${item.name}`}
                        onClick={() => setEditor(item.id)}
                      >
                        <Icon name="Pencil" />
                      </button>
                      <button
                        className="icon-button accent"
                        disabled={busy}
                        title={t('ui.copyProfile')}
                        aria-label={`${t('ui.copyProfile')}: ${item.name}`}
                        onClick={() => void duplicate(item.id, item.name)}
                      >
                        <Icon name="Copy" />
                      </button>
                      <button
                        className="icon-button danger"
                        disabled={busy}
                        title={t('library.remove')}
                        aria-label={`${t('library.remove')}: ${item.name}`}
                        onClick={() => setRemoving(item.id)}
                      >
                        <Icon name="Trash2" />
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="muted">{t('ui.emptyFolder')}</p>
                )}
              </details>
            );
          })}
          {!snapshot.profiles.length && !folders.length ? (
            <div className="empty-profiles">
              <Icon name="Plug" />
              <h3>{t('ui.emptyProfiles')}</h3>
              <p>{t('ui.addProfileHint')}</p>
            </div>
          ) : null}
          {search &&
          !snapshot.profiles.some((item) =>
            item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
          ) ? (
            <p role="status">{t('ui.noResults')}</p>
          ) : null}
        </div>
        {removing ? (
          <section className="inline-form">
            <p>
              {t('library.removeWarning')}{' '}
              {snapshot.profiles.find((item) => item.id === removing)?.name}
            </p>
            <div className="dialog-actions">
              <button disabled={busy} onClick={() => setRemoving(null)}>
                {t('ui.cancel')}
              </button>
              <button
                className="destructive"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void run({ action: 'delete-profile', profileId: removing })
                    .then((result) => {
                      if (result) setRemoving(null);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {t('operations.confirm')}
              </button>
            </div>
          </section>
        ) : null}
        {summary ? <p role="status">{summary}</p> : null}
        {errorKey ? (
          <p role="alert" className="inline-error">
            {t(errorKey)}
          </p>
        ) : null}
      </section>
      <div className="dialog-actions dialog-footer">
        <button disabled={busy} onClick={close}>
          {t('library.close')}
        </button>
      </div>
    </Dialog>
  );
};
