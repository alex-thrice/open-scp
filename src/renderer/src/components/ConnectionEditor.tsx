import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult, WorkspaceSnapshot } from '@shared/ipc/workspace';
import { ConnectionForm } from './ConnectionForm';
import { S3ConnectionForm } from './S3ConnectionForm';
import { FtpConnectionForm } from './FtpConnectionForm';
import { MailruConnectionForm } from './MailruConnectionForm';
import { GoogleConnectionForm } from './GoogleConnectionForm';
import { YandexConnectionForm } from './YandexConnectionForm';
import type { WorkspaceRunner } from './useWorkspaceService';
import type { ModalResult } from './Dialog';

export const ConnectionEditor = ({
  profile,
  snapshot,
  run,
  onClose,
  errorKey,
}: {
  readonly profile: ConnectionProfile | undefined;
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly onClose: () => void;
  readonly errorKey: string | null;
}) => {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ConnectionProfile['kind']>(profile?.kind ?? 'sftp');
  const [nameDraft, setNameDraft] = useState(profile?.name ?? '');
  const [group, setGroup] = useState(profile ? (snapshot.profileGroups?.[profile.id] ?? '') : '');
  const [busy, setBusy] = useState(false);
  const savedId = useRef(profile?.id);
  const profileId = useRef(profile?.id ?? crypto.randomUUID());
  const editId = useRef<string | undefined>(undefined);
  const finish = async (result: ModalResult) => {
    if (busy) return;
    setBusy(true);
    try {
      if (
        editId.current &&
        !(await run({ action: 'finish-profile-edit', editId: editId.current, result }))
      )
        return;
      editId.current = undefined;
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const folders = [
    ...new Set(
      [...(snapshot.profileFolders ?? []), ...Object.values(snapshot.profileGroups ?? {})].filter(
        Boolean,
      ),
    ),
  ];
  const afterSave = async (result: WorkspaceResult) => {
    const id = savedId.current ?? result.savedProfileId;
    if (!id) return false;
    savedId.current = id;
    return !!(await run({ action: 'set-profile-group', profileId: id, group }));
  };
  const execute: WorkspaceRunner = async (request) => {
    setBusy(true);
    try {
      if (
        request.action === 'save-profile' ||
        request.action === 'save-s3-profile' ||
        request.action === 'save-ftp-profile' ||
        request.action === 'save-mailru-profile' ||
        request.action === 'save-yandex-profile' ||
        request.action === 'save-google-profile'
      ) {
        if (!editId.current) {
          const result = await run({ action: 'begin-profile-edit', profileId: profileId.current });
          if (!result?.profileEditId) return undefined;
          editId.current = result.profileEditId;
        }
        request = {
          ...request,
          profile: { ...request.profile, id: profileId.current },
        } as typeof request;
      }
      return await run(request);
    } finally {
      setBusy(false);
    }
  };
  const editorControls = (
    <>
      <label>
        {t('ui.profileGroup')}
        <select
          aria-label={t('ui.profileGroup')}
          value={group}
          disabled={busy}
          onChange={(event) => setGroup(event.currentTarget.value)}
        >
          <option value="">{t('ui.ungrouped')}</option>
          {folders.map((folder) => (
            <option key={folder}>{folder}</option>
          ))}
        </select>
      </label>
      <label>
        {t('ui.profileType')}
        <select
          aria-label={t('ui.profileType')}
          value={kind}
          disabled={!!profile || !!savedId.current || busy}
          onChange={(event) => {
            const name = event.currentTarget.form?.elements.namedItem('name');
            if (name instanceof HTMLInputElement) setNameDraft(name.value);
            setKind(event.currentTarget.value as typeof kind);
          }}
        >
          <option value="sftp">SFTP</option>
          <option value="s3">S3</option>
          <option value="ftp">FTP</option>
          <option value="mailru">{t('mailru.name')}</option>
          <option value="yandex">{t('yandex.name')}</option>
          <option value="google">{t('google.name')}</option>
        </select>
      </label>
    </>
  );
  return kind === 'google' ? (
    <GoogleConnectionForm
      initialName={nameDraft}
      profile={profile?.kind === 'google' ? profile : undefined}
      snapshot={snapshot}
      run={execute}
      onClose={() => void finish('cancel')}
      onConfirm={() => void finish('ok')}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  ) : kind === 'yandex' ? (
    <YandexConnectionForm
      initialName={nameDraft}
      profile={profile?.kind === 'yandex' ? profile : undefined}
      snapshot={snapshot}
      run={execute}
      onClose={() => void finish('cancel')}
      onConfirm={() => void finish('ok')}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  ) : kind === 's3' ? (
    <S3ConnectionForm
      initialName={nameDraft}
      profile={profile?.kind === 's3' ? profile : undefined}
      run={execute}
      onClose={() => void finish('cancel')}
      onConfirm={() => void finish('ok')}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  ) : kind === 'mailru' ? (
    <MailruConnectionForm
      initialName={nameDraft}
      profile={profile?.kind === 'mailru' ? profile : undefined}
      run={execute}
      onClose={() => void finish('cancel')}
      onConfirm={() => void finish('ok')}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  ) : kind === 'ftp' ? (
    <FtpConnectionForm
      initialName={nameDraft}
      profile={profile?.kind === 'ftp' ? profile : undefined}
      run={execute}
      onClose={() => void finish('cancel')}
      onConfirm={() => void finish('ok')}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  ) : (
    <ConnectionForm
      initialName={nameDraft}
      profile={profile?.kind === 'sftp' ? profile : undefined}
      run={execute}
      onClose={() => void finish('cancel')}
      onConfirm={() => void finish('ok')}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  );
};
