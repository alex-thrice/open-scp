import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ICloudConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { useProfileConnectionTest } from './useProfileConnectionTest';

export const ICloudConnectionForm = ({
  profile,
  run,
  onClose,
  onConfirm,
  errorKey,
  editorControls,
  afterSave,
  initialName,
}: {
  readonly profile: ICloudConnectionProfile | undefined;
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
    setIsSaving(true);
    try {
      const result = await run({
        action: 'save-icloud-profile',
        profile: {
          id: profile?.id ?? createdId,
          name: String(data.get('name')),
          remote: String(data.get('remote')),
          initialDirectory: String(data.get('initialDirectory')),
          timeout: Number(data.get('timeout')),
        },
      });
      if (!result?.savedProfileId) return;
      setCreatedId(result.savedProfileId);
      if (afterSave && !(await afterSave(result))) return;
      if (testConnection) await connectionTest.test(result.savedProfileId);
      else (onConfirm ?? onClose)();
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog
      title={t('icloud.profile')}
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
            data-dialog-autofocus
            defaultValue={profile?.name ?? initialName ?? ''}
            name="name"
            maxLength={200}
            required
          />
        </label>
        {editorControls}
        <p className="muted small">{t('icloud.setupHint')}</p>
        <label>
          {t('icloud.remote')}
          <input
            defaultValue={profile?.remote ?? 'icloud'}
            name="remote"
            pattern="[A-Za-z_][A-Za-z0-9_\-]{0,99}"
            maxLength={100}
            required
          />
        </label>
        <small>{t('icloud.remoteHint')}</small>
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
              defaultValue={profile?.timeout ?? 60000}
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
