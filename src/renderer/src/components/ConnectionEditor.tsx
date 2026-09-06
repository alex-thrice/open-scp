import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionProfile } from '@shared/models/connection-profile';
import type { WorkspaceResult, WorkspaceSnapshot } from '@shared/ipc/workspace';
import { ConnectionForm } from './ConnectionForm';
import { S3ConnectionForm } from './S3ConnectionForm';
import type { WorkspaceRunner } from './useWorkspaceService';

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
  const [kind, setKind] = useState<'sftp' | 's3'>(profile?.kind ?? 'sftp');
  const [group, setGroup] = useState(profile ? (snapshot.profileGroups?.[profile.id] ?? '') : '');
  const [busy, setBusy] = useState(false);
  const savedId = useRef(profile?.id);
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
          onChange={(event) => setKind(event.currentTarget.value as typeof kind)}
        >
          <option value="sftp">SFTP</option>
          <option value="s3">S3</option>
        </select>
      </label>
    </>
  );
  return kind === 's3' ? (
    <S3ConnectionForm
      profile={profile?.kind === 's3' ? profile : undefined}
      run={execute}
      onClose={onClose}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  ) : (
    <ConnectionForm
      profile={profile?.kind === 'sftp' ? profile : undefined}
      run={execute}
      onClose={onClose}
      errorKey={errorKey}
      editorControls={editorControls}
      afterSave={afterSave}
    />
  );
};
