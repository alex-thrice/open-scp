import { googleDisplayPath, googleRootPath } from '@shared/models/google-path';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { GoogleConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult, WorkspaceSnapshot } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { useProfileConnectionTest } from './useProfileConnectionTest';
import { GoogleAuthorizationControls } from './GoogleAuthorizationControls';

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
  const form = useRef<HTMLFormElement>(null);
  const authorizeSubmission = useRef(false);
  const [createdId, setCreatedId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const id = profile?.id ?? createdId;
  const authorization = snapshot.googleAuthorizations?.find((entry) => entry.profileId === id);
  const waiting = authorization?.state === 'waiting' || authorization?.state === 'exchanging';
  const connectionTest = useProfileConnectionTest(run, errorKey);
  const busy = saving || connectionTest.isTesting;
  const close = () => {
    if (busy) return;
    if (id && waiting) void run({ action: 'cancel-google-authorization', profileId: id });
    onClose();
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    const authorize = authorizeSubmission.current;
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
          id: id ?? null,
          name: String(data.get('name')),
          initialDirectory: String(data.get('initialDirectory')),
          timeout: Number(data.get('timeout')),
        },
      });
      if (!result?.savedProfileId) return;
      setCreatedId(result.savedProfileId);
      if (afterSave && !(await afterSave(result))) return;
      if (authorize)
        await run({ action: 'authorize-google-profile', profileId: result.savedProfileId });
      else if (test) await connectionTest.test(result.savedProfileId);
      else (onConfirm ?? onClose)();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t('ui.connections')}
      onClose={close}
      notice={
        connectionTest.feedback ??
        (authorization?.errorKey ? (
          <p role="alert" className="connection-feedback connection-feedback--error">
            {t(authorization.errorKey)}
          </p>
        ) : null)
      }
      footer={
        <>
          <button type="button" disabled={busy} onClick={close}>
            {t('connections.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || waiting}
            form={formId}
            onClick={(event) => connectionTest.submitTest(event.currentTarget.form)}
          >
            {t('connections.test')}
          </button>
          <button className="primary" type="submit" disabled={busy || waiting} form={formId}>
            {t('connections.save')}
          </button>
        </>
      }
    >
      {editorControls ? (
        <button className="back-button" type="button" disabled={busy} onClick={close}>
          ← {t('ui.backProfiles')}
        </button>
      ) : null}
      {invalid ? <p role="alert">{t('library.validation')}</p> : null}
      <form
        id={formId}
        ref={form}
        noValidate
        onInput={connectionTest.reset}
        onSubmit={(event) => void save(event)}
      >
        <label>
          {t('connections.name')}
          <input
            name="name"
            data-dialog-autofocus
            defaultValue={profile?.name ?? initialName ?? ''}
            maxLength={200}
            required
            disabled={waiting}
          />
        </label>
        {editorControls}
        <GoogleAuthorizationControls
          profileId={id}
          snapshot={snapshot}
          run={run}
          disabled={busy}
          onAuthorize={() => {
            authorizeSubmission.current = true;
            try {
              form.current?.requestSubmit();
            } finally {
              authorizeSubmission.current = false;
            }
          }}
        />
        <details className="advanced-fields">
          <summary>{t('ui.advanced')}</summary>
          <label>
            {t('connections.initialDirectory')}
            <select
              name="initialDirectory"
              defaultValue={profile?.initialDirectory ?? googleRootPath}
              title={t('google.initialDirectoryHint')}
              required
              disabled={waiting}
            >
              {[
                ...new Set([
                  googleRootPath,
                  profile?.initialDirectory ?? googleRootPath,
                  ...snapshot.sessions
                    .filter((session) => session.profileId === id && session.kind === 'google')
                    .map((session) => session.currentPath ?? googleRootPath),
                ]),
              ].map((path) => (
                <option key={path} value={path}>
                  {googleDisplayPath(path)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('connections.timeout')}
            <input
              name="timeout"
              type="number"
              defaultValue={profile?.timeout ?? 30000}
              min={1000}
              max={120000}
              required
              disabled={waiting}
            />
          </label>
        </details>
      </form>
    </Dialog>
  );
};
