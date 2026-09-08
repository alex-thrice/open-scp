import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Appearance } from '@shared/ipc/workspace';
import {
  defaultKeyboardShortcuts,
  formatShortcut,
  sameShortcut,
  shortcutFromKeyboardEvent,
  type KeyboardShortcuts,
  type ShortcutAction,
} from '@shared/models/keyboard-shortcuts';
import type { UpdateSettings, UpdateState } from '@shared/models/application-update';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import type { WorkspaceRunner } from './useWorkspaceService';

type SettingsPage = 'appearance' | 'shortcuts' | 'updates' | 'advanced';

const shortcutLabels: readonly (readonly [ShortcutAction, string])[] = [
  ['newWorkspace', 'tabs.add'],
  ['closeWorkspace', 'ui.closeConnection'],
  ['switchPanel', 'commander.switchPanel'],
  ['createDirectory', 'operations.mkdir'],
  ['copy', 'operations.copy'],
  ['refresh', 'commander.refresh'],
  ['rename', 'operations.rename'],
  ['delete', 'operations.delete'],
  ['edit', 'operations.edit'],
  ['parentDirectory', 'commander.up'],
];

export const SettingsDialog = ({
  appearance,
  confirmTabClose,
  editorPath,
  initialPage,
  keyboardShortcuts,
  puttyPath,
  rememberPaths,
  updateSettings,
  updateState,
  run,
  errorKey,
  onClose,
}: {
  readonly appearance: Appearance;
  readonly confirmTabClose: boolean;
  readonly editorPath: string | null;
  readonly initialPage: SettingsPage;
  readonly keyboardShortcuts: KeyboardShortcuts;
  readonly puttyPath: string | null;
  readonly rememberPaths: boolean;
  readonly updateSettings: UpdateSettings;
  readonly updateState: UpdateState | undefined;
  readonly run: WorkspaceRunner;
  readonly errorKey: string | null;
  readonly onClose: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [busy, setBusy] = useState(false);
  const [editingShortcut, setEditingShortcut] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [draft, setDraft] = useState(appearance);
  const [editorPathDraft, setEditorPathDraft] = useState(editorPath ?? '');
  const [puttyPathDraft, setPuttyPathDraft] = useState(puttyPath ?? '');
  const isMac = /Mac/iu.test(navigator.platform);
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
  const saveShortcuts = async (shortcuts: KeyboardShortcuts) => {
    if (busy) return;
    setBusy(true);
    try {
      await run({ action: 'set-keyboard-shortcuts', shortcuts });
    } finally {
      setBusy(false);
    }
  };
  const saveUpdateSettings = async (value: Partial<UpdateSettings>) => {
    if (busy) return;
    setBusy(true);
    try {
      await run({ action: 'set-update-settings', settings: { ...updateSettings, ...value } });
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
          {(['appearance', 'shortcuts', 'updates', 'advanced'] as const).map((name) => (
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
                      : name === 'updates'
                        ? 'RefreshCw'
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
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmTabClose}
                  disabled={busy}
                  onChange={(event) => {
                    setBusy(true);
                    void run({
                      action: 'set-confirm-tab-close',
                      enabled: event.currentTarget.checked,
                    }).finally(() => setBusy(false));
                  }}
                />
                <span>
                  {t('tabs.confirmSetting')}
                  <small>{t('tabs.confirmSettingHint')}</small>
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
            <>
              <p className="muted">{t('shortcuts.hint')}</p>
              <dl className="shortcut-list">
                {shortcutLabels.map(([action, label]) => (
                  <div key={action}>
                    <dt>{t(label)}</dt>
                    <dd>
                      <button
                        className="shortcut-capture"
                        disabled={busy}
                        type="button"
                        onClick={() => {
                          setShortcutError(null);
                          setEditingShortcut(action);
                        }}
                        onKeyDown={(event) => {
                          if (editingShortcut !== action) return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.key === 'Escape') {
                            setEditingShortcut(null);
                            return;
                          }
                          const shortcut = shortcutFromKeyboardEvent(event);
                          if (!shortcut) {
                            setShortcutError('shortcuts.invalid');
                            return;
                          }
                          const duplicate = shortcutLabels.find(
                            ([candidate]) =>
                              candidate !== action &&
                              sameShortcut(keyboardShortcuts[candidate], shortcut),
                          );
                          if (duplicate) {
                            setShortcutError('shortcuts.duplicate');
                            return;
                          }
                          setEditingShortcut(null);
                          setShortcutError(null);
                          void saveShortcuts({ ...keyboardShortcuts, [action]: shortcut });
                        }}
                      >
                        <kbd>
                          {editingShortcut === action
                            ? t('shortcuts.press')
                            : formatShortcut(keyboardShortcuts[action], isMac)}
                        </kbd>
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
              <button
                disabled={busy}
                type="button"
                onClick={() => void saveShortcuts(defaultKeyboardShortcuts)}
              >
                {t('shortcuts.reset')}
              </button>
              {shortcutError ? (
                <p role="alert" className="inline-error">
                  {t(shortcutError)}
                </p>
              ) : null}
            </>
          ) : page === 'updates' ? (
            <>
              <p className="muted">{t('updates.hint')}</p>
              <p>{t('updates.currentVersion', { version: updateState?.currentVersion ?? '—' })}</p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={updateSettings.automaticCheck}
                  disabled={busy}
                  onChange={(event) =>
                    void saveUpdateSettings({ automaticCheck: event.currentTarget.checked })
                  }
                />
                <span>{t('updates.automaticCheck')}</span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={updateSettings.automaticDownload}
                  disabled={busy}
                  onChange={(event) =>
                    void saveUpdateSettings({ automaticDownload: event.currentTarget.checked })
                  }
                />
                <span>{t('updates.automaticDownload')}</span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={updateSettings.automaticInstall}
                  disabled={busy}
                  onChange={(event) =>
                    void saveUpdateSettings({ automaticInstall: event.currentTarget.checked })
                  }
                />
                <span>
                  {t('updates.automaticInstall')}
                  <small>{t('updates.automaticInstallHint')}</small>
                </span>
              </label>
              {updateState ? (
                <p role="status">
                  {t(`updates.status.${updateState.status}`, {
                    version: updateState.availableVersion ?? '',
                    progress: Math.round(updateState.progress ?? 0),
                  })}
                </p>
              ) : null}
              <div className="button-group">
                <button
                  disabled={
                    busy ||
                    updateState?.supported !== true ||
                    ['checking', 'downloading'].includes(updateState.status)
                  }
                  type="button"
                  onClick={() => {
                    setBusy(true);
                    void run({ action: 'check-for-updates' }).finally(() => setBusy(false));
                  }}
                >
                  <Icon name="RefreshCw" />
                  {t('updates.check')}
                </button>
                {updateState?.status === 'available' ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => {
                      setBusy(true);
                      void run({ action: 'download-update' }).finally(() => setBusy(false));
                    }}
                  >
                    {t('updates.download')}
                  </button>
                ) : null}
                {updateState?.status === 'downloaded' ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void run({ action: 'install-update' })}
                  >
                    {t('updates.install')}
                  </button>
                ) : null}
              </div>
              {updateState?.errorKey ? (
                <p role="alert" className="inline-error">
                  {t(updateState.errorKey)}
                </p>
              ) : null}
            </>
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
              <div className="button-group">
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    setBusy(true);
                    void run({ action: 'pick-editor' })
                      .then((result) => {
                        if (result?.selectedPath) setEditorPathDraft(result.selectedPath);
                      })
                      .finally(() => setBusy(false));
                  }}
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
                  className="file-picker"
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
