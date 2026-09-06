import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import { useTranslation } from 'react-i18next';
import type { SftpConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';

export const ConnectionForm = ({
  profile,
  run,
  onClose,
  errorKey,
  editorControls,
  afterSave,
}: {
  readonly profile: SftpConnectionProfile | undefined;
  readonly run: WorkspaceRunner;
  readonly onClose: () => void;
  readonly errorKey: string | null;
  readonly editorControls?: ReactNode;
  readonly afterSave?: (result: WorkspaceResult) => Promise<boolean>;
}) => {
  const { t } = useTranslation();
  const formId = useId();
  const [authMode, setAuthMode] = useState(profile?.authentication.method ?? 'agent');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const data = new FormData(form);
    const secretInput = form.elements.namedItem('secret') as HTMLInputElement;
    const secret = secretInput.value;
    secretInput.value = '';
    setIsSaving(true);
    const result = await run({
      action: 'save-profile',
      profile: {
        id: profile?.id ?? createdId,
        name: String(data.get('name')),
        host: String(data.get('host')),
        port: Number(data.get('port')),
        username: String(data.get('username')),
        initialDirectory: String(data.get('initialDirectory')),
        timeout: Number(data.get('timeout')),
        keepalive: Number(data.get('keepalive')),
        authMode,
        privateKeyPath: keyInput.current?.value ?? '',
      },
      ...(secret === '' || authMode === 'agent' ? {} : { secret }),
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
              defaultValue={profile?.port ?? 22}
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
          {t('connections.authMode')}
          <select
            aria-label={t('connections.authMode')}
            value={authMode}
            onChange={(event) => setAuthMode(event.currentTarget.value as typeof authMode)}
          >
            <option value="password">{t('connections.password')}</option>
            <option value="private-key">{t('connections.privateKey')}</option>
            <option value="agent">{t('connections.agent')}</option>
          </select>
        </label>
        <label hidden={authMode !== 'private-key'}>
          {t('connections.privateKey')}
          <input
            defaultValue={
              profile?.authentication.method === 'private-key'
                ? profile.authentication.privateKeyPath
                : ''
            }
            name="privateKeyPath"
            ref={keyInput}
          />
          <button
            type="button"
            onClick={() =>
              void run({ action: 'pick-private-key' }).then((result) => {
                if (result?.privateKeyPath && keyInput.current)
                  keyInput.current.value = result.privateKeyPath;
              })
            }
          >
            {t('connections.browse')}
          </button>
        </label>
        <label hidden={authMode === 'agent'}>
          {t(authMode === 'private-key' ? 'connections.passphrase' : 'connections.password')}
          <input autoComplete="off" name="secret" type="password" />
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
          <label>
            {t('connections.keepalive')}
            <input
              defaultValue={profile?.keepalive ?? 10000}
              min={1000}
              max={120000}
              name="keepalive"
              type="number"
              required
            />
          </label>
        </details>
      </form>
    </Dialog>
  );
};
