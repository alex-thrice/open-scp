import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import { Icon } from './Icon';
import { useTranslation } from 'react-i18next';
import type { S3ConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { useProfileConnectionTest } from './useProfileConnectionTest';

export const S3ConnectionForm = ({
  profile,
  run,
  onClose,
  onConfirm,
  errorKey,
  editorControls,
  afterSave,
  initialName,
}: {
  readonly profile: S3ConnectionProfile | undefined;
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
  const [isSaving, setIsSaving] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const connectionTest = useProfileConnectionTest(run, errorKey);
  const isBusy = isSaving || connectionTest.isTesting;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const shouldTest = connectionTest.isTestSubmission();
    connectionTest.reset();
    if (!form.checkValidity()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const data = new FormData(form);
    const keyInput = form.elements.namedItem('secretAccessKey') as HTMLInputElement;
    const tokenInput = form.elements.namedItem('sessionToken') as HTMLInputElement;
    const secretAccessKey = keyInput.value;
    const sessionToken = tokenInput.value;
    keyInput.value = '';
    tokenInput.value = '';
    setIsSaving(true);
    try {
      const result = await run({
        action: 'save-s3-profile',
        profile: {
          id: profile?.id ?? createdId,
          name: String(data.get('name')),
          endpoint: String(data.get('endpoint')).trim(),
          region: String(data.get('region')),
          bucket: String(data.get('bucket')).trim(),
          initialPrefix: String(data.get('initialPrefix')),
          accessKeyId: String(data.get('accessKeyId')),
          forcePathStyle: data.get('forcePathStyle') === 'on',
        },
        ...(secretAccessKey ? { secretAccessKey } : {}),
        ...(sessionToken || data.get('clearToken') === 'on' ? { sessionToken } : {}),
      });
      if (result) {
        if (result.savedProfileId) setCreatedId(result.savedProfileId);
        if (afterSave && !(await afterSave(result))) return;
        if (shouldTest && result.savedProfileId) await connectionTest.test(result.savedProfileId);
        else (onConfirm ?? onClose)();
      }
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog
      title={t('ui.connections')}
      notice={connectionTest.feedback}
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
      onClose={() => {
        if (!isBusy) onClose();
      }}
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
            name="name"
            required
            defaultValue={profile?.name ?? initialName ?? ''}
          />
        </label>
        {editorControls}
        <div className="s3-heading">
          <Icon name="Database" />
          {t('ui.protocolS3')}
        </div>
        <label>
          {t('s3.endpoint')}
          <input name="endpoint" type="url" defaultValue={profile?.endpoint ?? ''} />
        </label>
        <small>{t('s3.endpointHint')}</small>
        <div className="form-columns">
          <label>
            {t('s3.region')}
            <input name="region" required defaultValue={profile?.region ?? 'us-east-1'} />
          </label>
          <label>
            {t('s3.bucket')}
            <input name="bucket" defaultValue={profile?.bucket ?? ''} />
          </label>
        </div>
        <label>
          {t('s3.initialPrefix')}
          <input name="initialPrefix" defaultValue={profile?.initialPrefix ?? ''} />
        </label>
        <label>
          {t('s3.pathStyle')}
          <input
            name="forcePathStyle"
            type="checkbox"
            defaultChecked={profile?.forcePathStyle ?? false}
          />
        </label>
        <label>
          {t('s3.accessKeyId')}
          <input
            name="accessKeyId"
            required
            autoComplete="off"
            defaultValue={profile?.accessKeyId ?? ''}
          />
        </label>
        <label>
          {t('s3.secretAccessKey')}
          <input
            name="secretAccessKey"
            type="password"
            autoComplete="off"
            required={!profile?.secret && !createdId}
          />
        </label>
        <details className="advanced-fields">
          <summary>{t('ui.advanced')}</summary>
          <label>
            {t('s3.sessionToken')}
            <input name="sessionToken" type="password" autoComplete="off" />
          </label>
          {profile ? (
            <label>
              {t('s3.clearToken')}
              <input name="clearToken" type="checkbox" />
            </label>
          ) : null}
        </details>
        <small>{t('connections.secretHint')}</small>
      </form>
    </Dialog>
  );
};
