import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Appearance } from '@shared/ipc/workspace';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import type { WorkspaceRunner } from './useWorkspaceService';

export const SettingsDialog = ({
  appearance,
  editorPath,
  initialPage,
  puttyPath,
  rememberPaths,
  run,
  errorKey,
  onClose,
}: {
  readonly appearance: Appearance;
  readonly editorPath: string | null;
  readonly initialPage: 'appearance' | 'shortcuts' | 'advanced';
  readonly puttyPath: string | null;
  readonly rememberPaths: boolean;
  readonly run: WorkspaceRunner;
  readonly errorKey: string | null;
  readonly onClose: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<'appearance' | 'shortcuts' | 'advanced'>(initialPage);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(appearance);
  const [editorPathDraft, setEditorPathDraft] = useState(editorPath ?? '');
  const [puttyPathDraft, setPuttyPathDraft] = useState(puttyPath ?? '');
  const editorFileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(appearance);
  }, [appearance]);
  useEffect(() => {
    setEditorPathDraft(editorPath ?? '');
  }, [editorPath]);
  useEffect(() => {
    setPuttyPathDraft(puttyPath ?? '');
  }, [puttyPath]);
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const update = async (value: Partial<Appearance>) => {
    if (busy) return;
    const next = { ...draft, ...value };
    setDraft(next);
    setBusy(true);
    try {
      const result = await run({ action: 'set-appearance', appearance: next });
      if (!result) setDraft(appearance);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('ui.settings')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('ui.settings')}>
          {(['appearance', 'shortcuts', 'advanced'] as const).map((name) => (
            <button
              key={name}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => setPage(name)}
            >
              <Icon
                name={
                  name === 'appearance'
                    ? 'SlidersHorizontal'
                    : name === 'shortcuts'
                      ? 'Keyboard'
                      : 'Settings'
                }
              />
              {t(`ui.${name}`)}
            </button>
          ))}
        </nav>
        <section className="settings-content">
          <h3>{t(`ui.${page}`)}</h3>
          {page === 'appearance' ? (
            <>
              <p className="muted">{t('ui.themeHint')}</p>
              <div className="theme-options" role="group" aria-label={t('ui.appearance')}>
                {(['light', 'dark', 'system'] as const).map((theme) => (
                  <button
                    key={theme}
                    className="theme-option"
                    aria-pressed={draft.theme === theme}
                    disabled={busy}
                    onClick={() => void update({ theme })}
                  >
                    <span className="theme-preview" data-theme-preview={theme}>
                      <span />
                      <span />
                    </span>
                    <span>
                      <Icon
                        name={theme === 'light' ? 'Sun' : theme === 'dark' ? 'Moon' : 'Monitor'}
                      />
                      {t(`ui.${theme}`)}
                    </span>
                  </button>
                ))}
              </div>
              <label>
                {t('ui.density')}
                <select
                  aria-label={t('ui.density')}
                  disabled={busy}
                  value={draft.density}
                  onChange={(event) =>
                    void update({ density: event.currentTarget.value as Appearance['density'] })
                  }
                >
                  <option value="comfortable">{t('ui.comfortable')}</option>
                  <option value="compact">{t('ui.compact')}</option>
                </select>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.showHidden}
                  disabled={busy}
                  onChange={(event) => void update({ showHidden: event.currentTarget.checked })}
                />
                <span>
                  {t('ui.hidden')}
                  <small>{t('ui.hiddenHint')}</small>
                </span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={rememberPaths}
                  disabled={busy}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    setBusy(true);
                    void run({ action: 'set-remember-paths', enabled }).finally(() =>
                      setBusy(false),
                    );
                  }}
                />
                <span>
                  {t('path.remember')}
                  <small>{t('path.rememberHint')}</small>
                </span>
              </label>
              <label>
                {t('language.label')}
                <select
                  aria-label={t('language.label')}
                  disabled={busy}
                  value={i18n.resolvedLanguage ?? i18n.language}
                  onChange={(event) => {
                    const language = event.currentTarget.value as 'en' | 'ru';
                    setBusy(true);
                    void run({ action: 'set-language', language })
                      .then((result) => {
                        if (result) void i18n.changeLanguage(language);
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  <option value="ru">{t('language.russian')}</option>
                  <option value="en">{t('language.english')}</option>
                </select>
              </label>
            </>
          ) : page === 'shortcuts' ? (
            <dl className="shortcut-list">
              {[
                ['Ctrl / ⌘ + T', 'tabs.add'],
                ['Ctrl / ⌘ + W', 'ui.closeConnection'],
                ['F6', 'commander.switchPanel'],
                ['F7', 'operations.mkdir'],
                ['F5', 'operations.copy'],
                ['Ctrl+F5', 'commander.refresh'],
                ['F2', 'operations.rename'],
                ['Delete', 'operations.delete'],
                ['F4', 'operations.edit'],
                ['Backspace', 'commander.up'],
              ].map(([key, label]) => (
                <div key={key}>
                  <dt>{t(label ?? '')}</dt>
                  <dd>
                    <kbd>{key}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <h4>{t('library.diagnostics')}</h4>
              <p className="muted">{t('library.diagnosticsHint')}</p>
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void run({ action: 'save-export', kind: 'diagnostics' }).finally(() =>
                    setBusy(false),
                  );
                }}
              >
                <Icon name="FileOutput" />
                {t('library.report')}
              </button>
              <h4>{t('terminal.settings')}</h4>
              <p className="muted">{t('terminal.settingsHint')}</p>
              <label>
                {t('terminal.puttyPath')}
                <input
                  aria-label={t('terminal.puttyPath')}
                  disabled={busy}
                  maxLength={32768}
                  placeholder={t('terminal.puttyPathPlaceholder')}
                  value={puttyPathDraft}
                  onChange={(event) => setPuttyPathDraft(event.currentTarget.value)}
                />
              </label>
              <button
                disabled={busy || puttyPathDraft === (puttyPath ?? '')}
                onClick={() => {
                  setBusy(true);
                  const path = puttyPathDraft.trim();
                  void run({ action: 'set-putty-path', path: path || null }).finally(() =>
                    setBusy(false),
                  );
                }}
              >
                <Icon name="SquareTerminal" />
                {t('terminal.savePath')}
              </button>
              <h4>{t('editor.settings')}</h4>
              <p className="muted">{t('editor.settingsHint')}</p>
              <label>
                {t('editor.path')}
                <input
                  aria-label={t('editor.path')}
                  disabled={busy}
                  maxLength={32768}
                  placeholder={t('editor.pathPlaceholder')}
                  value={editorPathDraft}
                  onChange={(event) => setEditorPathDraft(event.currentTarget.value)}
                />
              </label>
              <input
                ref={editorFileInput}
                aria-label={t('editor.chooseFile')}
                disabled={busy}
                hidden
                type="file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  const path = file ? window.desktop.getPathForFile?.(file) : undefined;
                  if (path) setEditorPathDraft(path);
                  event.currentTarget.value = '';
                }}
              />
              <div className="button-group">
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => editorFileInput.current?.click()}
                >
                  <Icon name="FileInput" />
                  {t('editor.chooseFile')}
                </button>
                <button
                  disabled={busy || editorPathDraft === (editorPath ?? '')}
                  type="button"
                  onClick={() => {
                    setBusy(true);
                    const path = editorPathDraft.trim();
                    void run({ action: 'set-editor-path', path: path || null }).finally(() =>
                      setBusy(false),
                    );
                  }}
                >
                  <Icon name="TextCursorInput" />
                  {t('editor.savePath')}
                </button>
              </div>
              <h4>{t('library.knownHosts')}</h4>
              <p className="muted">{t('library.importWarning')}</p>
              <label>
                {t('library.chooseFile')}
                <input
                  type="file"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    setContent('');
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
                  value={content}
                  maxLength={1048576}
                  disabled={busy}
                  onChange={(event) => setContent(event.currentTarget.value)}
                />
              </label>
              <button
                disabled={busy || !content.trim()}
                onClick={() => {
                  setBusy(true);
                  void run({ action: 'import-known-hosts', content })
                    .then((result) => {
                      if (result?.importSummary) {
                        setContent('');
                        setSummary(t('library.summary', result.importSummary));
                      }
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {t('library.importConfirm')}
              </button>
              {summary ? <p role="status">{summary}</p> : null}
            </>
          )}
          {errorKey ? (
            <p role="alert" className="inline-error">
              {t(errorKey)}
            </p>
          ) : null}
        </section>
      </div>
      <div className="dialog-actions dialog-footer">
        <button disabled={busy} onClick={onClose}>
          {t('ui.done')}
        </button>
      </div>
    </Dialog>
  );
};
