import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TransferSnapshot } from '@shared/models/transfer-snapshot';
import type { WorkspaceRunner } from './useWorkspaceService';
import { formatSize } from '../i18n/format';

export const TransferQueue = ({
  transfers,
  run,
}: {
  readonly transfers: readonly TransferSnapshot[];
  readonly run: WorkspaceRunner;
}) => {
  const { t, i18n } = useTranslation();
  const [applyToAll, setApplyToAll] = useState<Record<string, boolean>>({});
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
  return (
    <section className="transfer-queue">
      <h2>{t('queue.title')}</h2>
      {transfers.some((item) => ['completed', 'cancelled'].includes(item.state)) ? (
        <button
          className="queue-clear"
          onClick={() => void run({ action: 'clear-transfer-history' })}
        >
          {t('queue.clearHistory')}
        </button>
      ) : null}
      {transfers.length === 0 ? (
        <span>{t('queue.empty')}</span>
      ) : (
        <div className="transfer-items">
          {transfers.map((item) => (
            <div className="transfer-item" key={item.id}>
              <div
                title={`${item.sourcePath} → ${item.destinationPath}`}
                className="transfer-item__path"
              >
                {item.sourcePath} → {item.destinationPath}
              </div>
              <progress
                aria-label={t('transfers.progress')}
                max={100}
                value={
                  item.state === 'completed'
                    ? 100
                    : item.totalBytes > 0n
                      ? Number((item.transferredBytes * 100n) / item.totalBytes)
                      : 0
                }
              />
              <span>
                {t(`transfers.states.${item.state}`)} ·{' '}
                {t('formats.metrics', {
                  bytes: formatSize(item.transferredBytes, i18n.language),
                  total: formatSize(item.totalBytes, i18n.language),
                  speed: t('formats.speed', { size: formatSize(item.speed, i18n.language) }),
                  elapsed: number.format(item.elapsed),
                  remaining:
                    item.remaining === null
                      ? t('common.notAvailable')
                      : number.format(item.remaining),
                })}
              </span>
              {item.errorKey ? <span role="alert">{t(item.errorKey)}</span> : null}
              {item.reviewReason ? (
                <span role="status">{t(`recovery.${item.reviewReason}`)}</span>
              ) : null}
              {['running', 'queued'].includes(item.state) ? (
                <button onClick={() => void run({ action: 'cancel-transfer', id: item.id })}>
                  {t('transfers.cancel')}
                </button>
              ) : null}
              {['failed', 'cancelled'].includes(item.state) || item.reviewReason ? (
                <>
                  {!item.reviewReason ? (
                    <button
                      onClick={() =>
                        void run({ action: 'retry-transfer', id: item.id, resume: true })
                      }
                    >
                      {t('transfers.resume')}
                    </button>
                  ) : null}
                  <button
                    onClick={() =>
                      void run({ action: 'retry-transfer', id: item.id, resume: false })
                    }
                  >
                    {t('transfers.restart')}
                  </button>
                </>
              ) : null}
              {item.state === 'requiring-review' && item.conflictPath ? (
                <div className="transfer-conflict" role="alertdialog">
                  <strong>{t('transfers.conflictTitle')}</strong>
                  <span>
                    {t('transfers.conflictSource', {
                      path: item.conflictSourcePath ?? item.sourcePath,
                    })}
                  </span>
                  <span>{t('transfers.conflictDestination', { path: item.conflictPath })}</span>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={applyToAll[item.id] ?? false}
                      onChange={(event) =>
                        setApplyToAll((current) => ({
                          ...current,
                          [item.id]: event.currentTarget.checked,
                        }))
                      }
                    />
                    <span>{t('transfers.applyToAll')}</span>
                  </label>
                  {(['overwrite', 'skip', 'rename'] as const).map((policy) => (
                    <button
                      key={policy}
                      onClick={() =>
                        void run({
                          action: 'resolve-conflict',
                          id: item.id,
                          policy,
                          applyToAll: applyToAll[item.id] ?? false,
                        })
                      }
                    >
                      {t(`transfers.policies.${policy}`)}
                    </button>
                  ))}
                  <button onClick={() => void run({ action: 'cancel-transfer', id: item.id })}>
                    {t('transfers.cancel')}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
