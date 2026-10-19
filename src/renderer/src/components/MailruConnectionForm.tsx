import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MailruConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { MailruPasswordLabel } from './MailruPasswordLabel';
import { useProfileConnectionTest } from './useProfileConnectionTest';

export const MailruConnectionForm = ({
  profile,
  run,
  onClose,
  errorKey,
  editorControls,
  afterSave,
}: {
  readonly profile: MailruConnectionProfile | undefined;
  readonly run: WorkspaceRunner;
  readonly onClose: () => void;
  readonly errorKey: string | null;
  readonly editorControls?: ReactNode;
  readonly afterSave?: (result: WorkspaceResult) => Promise<boolean>;
}) => {
  const { t } = useTranslation();
  const formId = useId();
  const passwordId = `${formId}-password`;
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const connectionTest = useProfileConnectionTest(run, errorKey);
  const isBusy = isSaving || connectionTest.isTesting;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const testConnection = connectionTest.isTestSubmission();
    connectionTest.reset();
    if (!form.checkValidity()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const data = new FormData(form);
    const passwordInput = form.elements.namedItem('password') as HTMLInputElement;
    const password = passwordInput.value;
    passwordInput.value = '';
    setIsSaving(true);
    try {
      const result = await run({
        action: 'save-mailru-profile',
        profile: {
          id: profile?.id ?? createdId,
          name: String(data.get('name')),
          username: String(data.get('username')),
          initialDirectory: String(data.get('initialDirectory')),
          timeout: Number(data.get('timeout')),
        },
        ...(password ? { password } : {}),
      });
      if (!result?.savedProfileId) return;
      setCreatedId(result.savedProfileId);
      if (afterSave && !(await afterSave(result))) return;
      if (testConnection) await connectionTest.test(result.savedProfileId);
      else onClose();
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog
      title={t('mailru.profile')}
      notice={connectionTest.feedback}
      onClose={() => {
        if (!isBusy) onClose();
      }}
      footer={
        <>
          <button disabled={isBusy} type="button" onClick={onClose}>
            {t('connections.cancel')}
          </button>
          <button
            disabled={isBusy}
            type="button"
            form={formId}
            onClick={(event) => connectionTest.submitTest(event.currentTarget.form)}
          >
            {t('connections.test')}
          </button>
          <button className="primary" disabled={isBusy} type="submit" form={formId}>
            {t('connections.save')}
          </button>
        </>
      }
    >
      {editorControls ? (
        <button className="back-button" type="button" disabled={isBusy} onClick={onClose}>
          ← {t('ui.backProfiles')}
        </button>
      ) : null}
      {invalid ? <p role="alert">{t('library.validation')}</p> : null}
      <form
        id={formId}
        noValidate
        onInput={connectionTest.reset}
        onSubmit={(event) => void save(event)}
      >
        <label>
          {t('connections.name')}
          <input
            autoFocus
            defaultValue={profile?.name ?? ''}
            name="name"
            maxLength={200}
            required
          />
        </label>
        {editorControls}
        <label>
          {t('mailru.email')}
          <input
            autoComplete="username"
            defaultValue={profile?.username ?? ''}
            name="username"
            type="email"
            maxLength={320}
            required
          />
        </label>
        <div className="form-field">
          <MailruPasswordLabel inputId={passwordId} />
          <input id={passwordId} autoComplete="off" name="password" type="password" />
        </div>
        <small>{t('connections.secretHint')}</small>
        <details className="advanced-fields">
          <summary>{t('ui.advanced')}</summary>
          <label>
            {t('connections.initialDirectory')}
            <input
              defaultValue={profile?.initialDirectory ?? '/'}
              name="initialDirectory"
              required
            />
          </label>
          <label>
            {t('connections.timeout')}
            <input
              defaultValue={profile?.timeout ?? 20000}
              min={1000}
              max={120000}
              name="timeout"
              type="number"
              required
            />
          </label>
        </details>
      </form>
    </Dialog>
  );
};
