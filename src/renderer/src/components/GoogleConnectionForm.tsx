import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { GoogleConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult, WorkspaceSnapshot } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { useProfileConnectionTest } from './useProfileConnectionTest';

export const GoogleConnectionForm = ({
  profile,
  snapshot,
  run,
  onClose,
  onConfirm,
  errorKey,
  editorControls,
  afterSave,
  initialName,
}: {
  readonly profile: GoogleConnectionProfile | undefined;
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly onClose: () => void;
  readonly onConfirm?: () => void;
  readonly errorKey: string | null;
  readonly editorControls?: ReactNode;
  readonly afterSave?: (result: WorkspaceResult) => Promise<boolean>;
  readonly initialName?: string;
}) => {
  const { t } = useTranslation();
  const formId = useId();
  const [createdId, setCreatedId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState(profile ? (profile.remote ?? '') : undefined);
  const runRef = useRef(run);
  runRef.current = run;
  const remotes = [...new Set(snapshot.googleRemotes ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  const remote = selection ?? remotes[0] ?? '';
  const isMissing = !!remote && !remotes.includes(remote);
  const connectionTest = useProfileConnectionTest(run, errorKey);
  const busy = saving || connectionTest.isTesting;
  const canSave = snapshot.rcloneAvailable === true && !!remote && !isMissing;
  useEffect(() => {
    let disposed = false;
    setRefreshing(true);
    void runRef.current({ action: 'refresh-rclone' }).finally(() => {
      if (!disposed) setRefreshing(false);
    });
    return () => {
      disposed = true;
    };
  }, []);
  const close = () => {
    if (!busy && !refreshing) onClose();
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || refreshing || !canSave) return;
    const target = event.currentTarget;
    const test = connectionTest.isTestSubmission();
    connectionTest.reset();
    if (!target.checkValidity()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const data = new FormData(target);
    setSaving(true);
    try {
      const result = await run({
        action: 'save-google-profile',
        profile: {
          id: profile?.id ?? createdId ?? null,
          name: String(data.get('name')),
          remote,
          initialDirectory: String(data.get('initialDirectory')),
          timeout: Number(data.get('timeout')),
        },
      });
      if (!result?.savedProfileId) return;
      setCreatedId(result.savedProfileId);
      if (afterSave && !(await afterSave(result))) return;
      if (test) await connectionTest.test(result.savedProfileId);
      else (onConfirm ?? onClose)();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t('ui.connections')}
      onClose={close}
      notice={connectionTest.feedback}
      footer={
        <>
          <button type="button" disabled={busy || refreshing} onClick={close}>
            {t('connections.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || refreshing || !canSave}
            form={formId}
            onClick={(event) => connectionTest.submitTest(event.currentTarget.form)}
          >
            {t('connections.test')}
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || refreshing || !canSave}
            form={formId}
          >
            {t('connections.save')}
          </button>
        </>
      }
    >
      {editorControls ? (
        <button className="back-button" type="button" disabled={busy || refreshing} onClick={close}>
          ← {t('ui.backProfiles')}
        </button>
      ) : null}
      {invalid ? <p role="alert">{t('library.validation')}</p> : null}
      {profile && !profile.remote ? <p role="status">{t('google.reconfigure')}</p> : null}
      <p className="muted small">{t('google.setupHint')}</p>
      {!snapshot.rcloneAvailable && !refreshing ? (
        <p role="status">{t('google.rcloneUnavailable')}</p>
      ) : null}
      <form
        id={formId}
        noValidate
        onInput={connectionTest.reset}
        onSubmit={(event) => void save(event)}
      >
        <fieldset className="icloud-profile-fields" disabled={busy}>
          <label>
            {t('connections.name')}
            <input
              name="name"
              data-dialog-autofocus
              defaultValue={profile?.name ?? initialName ?? ''}
              maxLength={200}
              required
            />
          </label>
          {editorControls}
          <label>
            {t('google.remote')}
            <select
              aria-label={t('google.remote')}
              name="remote"
              value={remote}
              disabled={refreshing || !remotes.length}
              onChange={(event) => setSelection(event.currentTarget.value)}
              required
            >
              {!remote ? (
                <option value="">
                  {t(
                    refreshing
                      ? 'icloud.loadingRemotes'
                      : remotes.length
                        ? 'google.chooseRemote'
                        : 'google.noRemotes',
                  )}
                </option>
              ) : null}
              {isMissing ? (
                <option value={remote} disabled>
                  {remote} ({t('icloud.remoteUnavailable')})
                </option>
              ) : null}
              {remotes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <small>{t('google.remoteHint')}</small>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void run({ action: 'refresh-rclone' }).finally(() => setRefreshing(false));
            }}
          >
            {t('icloud.refreshRemotes')}
          </button>
          <details className="advanced-fields">
            <summary>{t('ui.advanced')}</summary>
            <label>
              {t('connections.initialDirectory')}
              <input
                name="initialDirectory"
                defaultValue={
                  profile?.initialDirectory?.startsWith('/') ? profile.initialDirectory : '/'
                }
                required
              />
            </label>
            <label>
              {t('connections.timeout')}
              <input
                name="timeout"
                type="number"
                defaultValue={profile?.timeout ?? 60000}
                min={1000}
                max={120000}
                required
              />
            </label>
          </details>
        </fieldset>
      </form>
    </Dialog>
  );
};
