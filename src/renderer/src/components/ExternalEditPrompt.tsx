import { useTranslation } from 'react-i18next';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import { Dialog } from './Dialog';
import type { WorkspaceRunner } from './useWorkspaceService';

export const ExternalEditPrompt = ({
  edits,
  run,
}: {
  readonly edits: NonNullable<WorkspaceSnapshot['externalEdits']>;
  readonly run: WorkspaceRunner;
}) => {
  const { t } = useTranslation();
  const edit = edits.find((item) =>
    ['changed', 'conflict', 'failed', 'recovered'].includes(item.state),
  );
  if (!edit) return null;
  const isConflict = edit.state === 'conflict';

  return (
    <Dialog title={t('editor.changedTitle')} onClose={() => undefined}>
      <p>{t('editor.changedHint', { name: edit.fileName })}</p>
      <code>{edit.remotePath}</code>
      {edit.state === 'recovered' ? <p className="inline-notice">{t('editor.recovered')}</p> : null}
      {isConflict ? <p className="inline-error">{t('editor.conflict')}</p> : null}
      {edit.errorKey ? <p className="inline-error">{t(edit.errorKey)}</p> : null}
      <div className="dialog-actions">
        <button
          onClick={() =>
            void run({ action: 'resolve-external-edit', id: edit.id, resolution: 'discard' })
          }
        >
          {t('editor.discard')}
        </button>
        <button
          className={isConflict ? 'destructive' : 'primary'}
          onClick={() =>
            void run({
              action: 'resolve-external-edit',
              id: edit.id,
              resolution: isConflict ? 'overwrite' : 'upload',
            })
          }
        >
          {t(isConflict ? 'editor.overwrite' : 'editor.upload')}
        </button>
      </div>
    </Dialog>
  );
};
