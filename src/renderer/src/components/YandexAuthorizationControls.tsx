import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';

export const YandexAuthorizationControls = ({
  profileId,
  snapshot,
  run,
  onAuthorize,
  disabled = false,
}: {
  readonly profileId: string | undefined;
  readonly snapshot: WorkspaceSnapshot;
  readonly run: WorkspaceRunner;
  readonly onAuthorize?: () => void;
  readonly disabled?: boolean;
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const state = snapshot.yandexAuthorizations?.find((entry) => entry.profileId === profileId);
  const profile = snapshot.profiles.find((entry) => entry.id === profileId);
  const waiting = state?.state === 'waiting' || state?.state === 'exchanging';
  const execute = async (
    action:
      'authorize-yandex-profile' | 'cancel-yandex-authorization' | 'forget-yandex-authorization',
  ) => {
    if (!profileId || busy) return;
    setBusy(true);
    try {
      await run({ action, profileId });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="oauth-account">
      <span>
        {state?.authorized && profile?.kind === 'yandex'
          ? t('yandex.connectedAs', { account: profile.accountName ?? '' })
          : t('yandex.signedOut')}
      </span>
      {waiting ? (
        <>
          <p role="status">{t('yandex.waiting')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void execute('cancel-yandex-authorization')}
          >
            {t('yandex.cancelLogin')}
          </button>
        </>
      ) : (
        <div className="button-group">
          <button
            type="button"
            disabled={disabled || busy || !snapshot.yandexOAuthConfigured}
            onClick={() => (onAuthorize ? onAuthorize() : void execute('authorize-yandex-profile'))}
          >
            {t('yandex.signIn')}
          </button>
          {state?.authorized ? (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void execute('forget-yandex-authorization')}
            >
              {t('yandex.signOut')}
            </button>
          ) : null}
        </div>
      )}
      {!snapshot.yandexOAuthConfigured ? <small>{t('errors.oauth.configuration')}</small> : null}
    </div>
  );
};
