import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';

export const GoogleAuthorizationControls = ({
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
  const state = snapshot.googleAuthorizations?.find((entry) => entry.profileId === profileId);
  const profile = snapshot.profiles.find((entry) => entry.id === profileId);
  const waiting = state?.state === 'waiting' || state?.state === 'exchanging';
  const execute = async (
    action:
      'authorize-google-profile' | 'cancel-google-authorization' | 'forget-google-authorization',
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
        {state?.authorized && profile?.kind === 'google'
          ? t('google.connectedAs', { account: profile.accountName ?? '' })
          : t('google.signedOut')}
      </span>
      {waiting ? (
        <>
          <p role="status">{t('google.waiting')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void execute('cancel-google-authorization')}
          >
            {t('google.cancelLogin')}
          </button>
        </>
      ) : (
        <div className="button-group">
          <button
            type="button"
            disabled={disabled || busy || !snapshot.googleOAuthConfigured}
            onClick={() => (onAuthorize ? onAuthorize() : void execute('authorize-google-profile'))}
          >
            {t('google.signIn')}
          </button>
          {state?.authorized ? (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void execute('forget-google-authorization')}
            >
              {t('google.signOut')}
            </button>
          ) : null}
        </div>
      )}
      {!snapshot.googleOAuthConfigured ? <small>{t('errors.oauth.configuration')}</small> : null}
    </div>
  );
};
