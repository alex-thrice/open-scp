import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExternalDragSnapshot } from '@shared/ipc/file-drag';
import { formatSize } from '../i18n/format';
import { Icon } from './Icon';
import { startFileDrag } from './start-file-drag';

export const ExternalDragStatus = ({
  snapshot,
  onDismiss,
}: {
  readonly snapshot: ExternalDragSnapshot;
  readonly onDismiss: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const isReady = snapshot.state === 'ready';
  const error = errorKey ?? snapshot.errorKey;
  return (
    <div className="external-drag-status">
      <div role="status">
        {t(`fileDrag.${snapshot.state}`, { count: snapshot.fileCount })}
        {snapshot.state === 'preparing' ? (
          <>
            <progress
              aria-label={t('fileDrag.progress')}
              value={Number(snapshot.transferredBytes)}
              max={Number(snapshot.totalBytes) || 1}
            />
            <small>
              {formatSize(snapshot.transferredBytes, i18n.language)} /{' '}
              {formatSize(snapshot.totalBytes, i18n.language)}
            </small>
          </>
        ) : null}
      </div>
      {isReady ? (
        <button
          type="button"
          className="external-drag-handle"
          draggable
          title={t('fileDrag.dragHint')}
          onDragStart={(event) => {
            setErrorKey(null);
            startFileDrag(event, { source: 'prepared', id: snapshot.id }, setErrorKey);
          }}
        >
          <Icon name="FileOutput" />
          {t('fileDrag.drag')}
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="inline-error">
          {t(error)}
        </span>
      ) : null}
      <button type="button" onClick={onDismiss}>
        {t(snapshot.state === 'preparing' ? 'connections.cancel' : 'fileDrag.dismiss')}
      </button>
    </div>
  );
};
