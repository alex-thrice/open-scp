import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FtpConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export const FtpConnectionForm = ({
  profile,
  run,
  onClose,
  errorKey,
  editorControls,
  afterSave,
}: {
  readonly profile: FtpConnectionProfile | undefined;
  readonly run: WorkspaceRunner;
  readonly onClose: () => void;
  readonly errorKey: string | null;
  readonly editorControls?: ReactNode;
  readonly afterSave?: (result: WorkspaceResult) => Promise<boolean>;
}) => {
  const { t } = useTranslation();
  const formId = useId();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
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
    const result = await run({
      action: 'save-ftp-profile',
      profile: {
        id: profile?.id ?? createdId,
        name: String(data.get('name')),
        host: String(data.get('host')),
        port: Number(data.get('port')),
        username: String(data.get('username')),
        initialDirectory: String(data.get('initialDirectory')),
        timeout: Number(data.get('timeout')),
      },
      ...(password ? { password } : {}),
    });
    if (result) {
      if (result.savedProfileId) setCreatedId(result.savedProfileId);
      if (!afterSave || (await afterSave(result))) onClose();
    }
    setIsSaving(false);
  };
  return (
    <Dialog
      title={t('ui.connections')}
      footer={
        <>
          <button disabled={isSaving} type="button" onClick={onClose}>
            {t('connections.cancel')}
          </button>
          <button className="primary" disabled={isSaving} type="submit" form={formId}>
            {t('connections.save')}
          </button>
        </>
      }
      onClose={() => {
        if (!isSaving) onClose();
      }}
    >
      {editorControls ? (
        <button className="back-button" type="button" disabled={isSaving} onClick={onClose}>
          ← {t('ui.backProfiles')}
        </button>
      ) : null}
      {errorKey ? <div role="alert">{t(errorKey)}</div> : null}
      {invalid ? <p role="alert">{t('library.validation')}</p> : null}
      <div className="inline-error" role="alert">
        <Icon name="Plug" />
        {t('ftp.insecureWarning')}
      </div>
      <form id={formId} noValidate onSubmit={(event) => void save(event)}>
        <label>
          {t('connections.name')}
          <input autoFocus defaultValue={profile?.name ?? ''} name="name" required />
        </label>
        {editorControls}
        <div className="form-columns form-columns--host">
          <label>
            {t('connections.host')}
            <input defaultValue={profile?.host ?? ''} name="host" required />
          </label>
          <label>
            {t('connections.port')}
            <input
              defaultValue={profile?.port ?? 21}
              max={65535}
              min={1}
              name="port"
              required
              type="number"
            />
          </label>
        </div>
        <label>
          {t('connections.username')}
          <input
            autoComplete="username"
            defaultValue={profile?.username ?? ''}
            name="username"
            required
          />
        </label>
        <label>
          {t('connections.password')}
          <input autoComplete="off" name="password" type="password" />
        </label>
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
