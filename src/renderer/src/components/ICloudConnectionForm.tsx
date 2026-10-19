import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ICloudConnectionProfile } from '@shared/models/connection-profile';
import type { ICloudConfigurationResult } from '@shared/models/icloud-profile';
import type { z } from 'zod';
import type { icloudProfileDraftSchema } from '@shared/models/icloud-profile';
import { icloudRemoteSchema } from '@shared/models/icloud-profile';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';
import { Dialog } from './Dialog';
import { useProfileConnectionTest } from './useProfileConnectionTest';

export const ICloudConnectionForm = ({
  profile,
  run,
  onClose,
  onConfirm,
  errorKey,
  editorControls,
  afterSave,
  initialName,
  icloudRemotes,
}: {
  readonly profile: ICloudConnectionProfile | undefined;
  readonly run: WorkspaceRunner;
  readonly onClose: () => void;
  readonly onConfirm?: () => void;
  readonly errorKey: string | null;
  readonly editorControls?: ReactNode;
  readonly afterSave?: (result: WorkspaceResult) => Promise<boolean>;
  readonly initialName?: string;
  readonly icloudRemotes?: readonly string[];
}) => {
  const { t } = useTranslation();
  const formId = useId();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [configureAccount, setConfigureAccount] = useState(!profile);
  const [appleId, setAppleId] = useState('');
  const [existingSelection, setExistingSelection] = useState(profile?.remote);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [password, setPassword] = useState('');
  const [question, setQuestion] =
    useState<Extract<ICloudConfigurationResult, { status: 'question' }>>();
  const [answer, setAnswer] = useState('');
  const [configuredRemote, setConfiguredRemote] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);
  const session = useRef<string | undefined>(undefined);
  const cancelled = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const availableRemotes = [...new Set(icloudRemotes ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  const existingRemote = existingSelection ?? availableRemotes[0] ?? '';
  const remote = configureAccount ? configuredRemote || appleId.trim() : existingRemote;
  const isRemoteValid = icloudRemoteSchema.safeParse(remote).success;
  const isExistingMissing = !!existingRemote && !availableRemotes.includes(existingRemote);
  const canSaveRemote =
    isRemoteValid && (configureAccount || !isExistingMissing || existingRemote === profile?.remote);
  useEffect(() => {
    if (configureAccount) {
      setIsRefreshing(false);
      return;
    }
    let disposed = false;
    setIsRefreshing(true);
    void runRef.current({ action: 'refresh-rclone' }).finally(() => {
      if (!disposed) setIsRefreshing(false);
    });
    return () => {
      disposed = true;
    };
  }, [configureAccount]);
  type Draft = z.infer<typeof icloudProfileDraftSchema>;
  const pending = useRef<{ draft: Draft; testConnection: boolean } | undefined>(undefined);
  useEffect(
    () => () => {
      if (session.current)
        void runRef.current({ action: 'cancel-icloud-configuration', id: session.current });
    },
    [],
  );
  const connectionTest = useProfileConnectionTest(run, errorKey);
  const isBusy = isSaving || connectionTest.isTesting;
  const cancelSetup = async () => {
    if (isCancelling) return;
    cancelled.current = true;
    setIsCancelling(true);
    try {
      if (
        session.current &&
        !(await run({ action: 'cancel-icloud-configuration', id: session.current }))
      )
        return false;
      session.current = undefined;
      pending.current = undefined;
      setQuestion(undefined);
      setPassword('');
      setAnswer('');
      return true;
    } finally {
      setIsCancelling(false);
    }
  };
  const close = async () => {
    if (isBusy || isCancelling || isRefreshing) return;
    if (session.current && !(await cancelSetup())) return;
    onClose();
  };
  const saveProfile = async (draft: Draft, testConnection: boolean) => {
    const result = await run({ action: 'save-icloud-profile', profile: draft });
    if (!result?.savedProfileId) return;
    setCreatedId(result.savedProfileId);
    if (afterSave && !(await afterSave(result))) return;
    if (testConnection) await connectionTest.test(result.savedProfileId);
    else (onConfirm ?? onClose)();
  };
  const acceptConfiguration = async (result: WorkspaceResult | undefined) => {
    const configuration = result?.icloudConfiguration;
    if (cancelled.current || !configuration || configuration.status === 'cancelled') return;
    if (configuration.status === 'question') {
      setQuestion(configuration);
      setAnswer(configuration.choices[0]?.value ?? '');
    } else if (pending.current) {
      session.current = undefined;
      setQuestion(undefined);
      setConfiguredRemote(pending.current.draft.remote);
      await saveProfile(pending.current.draft, pending.current.testConnection);
    }
  };
  const continueSetup = async (value: string) => {
    if (!session.current || isBusy || isCancelling) return;
    setIsSaving(true);
    setAnswer('');
    try {
      await acceptConfiguration(
        await run({ action: 'continue-icloud-configuration', id: session.current, answer: value }),
      );
    } finally {
      setIsSaving(false);
    }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy || isCancelling || isRefreshing) return;
    if (question) {
      if (event.currentTarget.checkValidity()) await continueSetup(answer);
      else setInvalid(true);
      return;
    }
    if (!canSaveRemote) return;
    const form = event.currentTarget;
    const testConnection = connectionTest.isTestSubmission();
    connectionTest.reset();
    if (!form.checkValidity()) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const data = new FormData(form);
    setIsSaving(true);
    try {
      const draft = {
        id: profile?.id ?? createdId,
        name: String(data.get('name')),
        remote,
        initialDirectory: String(data.get('initialDirectory')),
        timeout: Number(data.get('timeout')),
      };
      if (configureAccount && !configuredRemote) {
        cancelled.current = false;
        const id = crypto.randomUUID();
        session.current = id;
        pending.current = { draft, testConnection };
        const secret = password;
        setPassword('');
        const result = await run({
          action: 'start-icloud-configuration',
          id,
          remote: draft.remote,
          appleId: appleId.trim(),
          password: secret,
        });
        if (!result) {
          session.current = undefined;
          pending.current = undefined;
        }
        await acceptConfiguration(result);
      } else await saveProfile(draft, testConnection);
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog
      title={t('icloud.profile')}
      notice={connectionTest.feedback}
      onClose={() => {
        void close();
      }}
      footer={
        <>
          <button
            disabled={isCancelling || isRefreshing || (isBusy && !session.current)}
            type="button"
            onClick={() => {
              if (isBusy) void cancelSetup();
              else void close();
            }}
          >
            {t(isBusy && session.current ? 'icloud.cancelSetup' : 'connections.cancel')}
          </button>
          <button
            disabled={isBusy || isCancelling || isRefreshing || !canSaveRemote || !!question}
            type="button"
            form={formId}
            onClick={(event) => connectionTest.submitTest(event.currentTarget.form)}
          >
            {t('connections.test')}
          </button>
          <button
            className="primary"
            disabled={isBusy || isCancelling || isRefreshing || (!question && !canSaveRemote)}
            type="submit"
            form={formId}
          >
            {t(
              question
                ? 'icloud.continue'
                : isBusy && configureAccount
                  ? 'icloud.signingIn'
                  : 'connections.save',
            )}
          </button>
        </>
      }
    >
      {editorControls ? (
        <button
          className="back-button"
          type="button"
          disabled={isBusy || isCancelling || isRefreshing}
          onClick={() => void close()}
        >
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
        <fieldset className="icloud-profile-fields" disabled={isBusy || isCancelling || !!question}>
          <label>
            {t('connections.name')}
            <input
              data-dialog-autofocus
              defaultValue={profile?.name ?? initialName ?? ''}
              name="name"
              maxLength={200}
              required
            />
          </label>
          {editorControls}
          <label>
            {t('icloud.setupMode')}
            <select
              aria-label={t('icloud.setupMode')}
              value={configureAccount ? 'new' : 'existing'}
              disabled={!!configuredRemote}
              onChange={(event) => {
                setConfigureAccount(event.currentTarget.value === 'new');
                setPassword('');
              }}
            >
              <option value="new">{t('icloud.newAccount')}</option>
              <option value="existing">{t('icloud.existingRemote')}</option>
            </select>
          </label>
          <p className="muted small">{t('icloud.setupHint')}</p>
          <label>
            {t('icloud.remote')}
            {configureAccount ? (
              <input
                aria-label={t('icloud.remote')}
                value={remote}
                placeholder={t('icloud.remoteFromEmail')}
                disabled
              />
            ) : (
              <select
                aria-label={t('icloud.remote')}
                value={existingRemote}
                disabled={isRefreshing || !availableRemotes.length}
                onChange={(event) => setExistingSelection(event.currentTarget.value)}
                required
              >
                {!existingRemote ? (
                  <option value="">
                    {t(isRefreshing ? 'icloud.loadingRemotes' : 'icloud.noExistingRemotes')}
                  </option>
                ) : null}
                {isExistingMissing ? (
                  <option value={existingRemote} disabled>
                    {existingRemote} ({t('icloud.remoteUnavailable')})
                  </option>
                ) : null}
                {availableRemotes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <small>
            {t(configureAccount ? 'icloud.remoteFromEmailHint' : 'icloud.existingRemoteHint')}
          </small>
          {configureAccount && remote && !isRemoteValid ? (
            <p role="alert">{t('icloud.emailRemoteInvalid')}</p>
          ) : null}
          {!configureAccount ? (
            <button
              type="button"
              disabled={isBusy || isCancelling || isRefreshing || !!question}
              onClick={() => {
                setIsRefreshing(true);
                void run({ action: 'refresh-rclone' }).finally(() => setIsRefreshing(false));
              }}
            >
              {t('icloud.refreshRemotes')}
            </button>
          ) : null}
          {configureAccount && !configuredRemote ? (
            <>
              <label>
                {t('icloud.appleId')}
                <input
                  name="appleId"
                  type="email"
                  autoComplete="username"
                  maxLength={320}
                  value={appleId}
                  onChange={(event) => setAppleId(event.currentTarget.value)}
                  required
                />
              </label>
              <label>
                {t('icloud.password')}
                <input
                  type="password"
                  autoComplete="current-password"
                  maxLength={4096}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  required
                />
              </label>
              <small>{t('icloud.passwordHint')}</small>
            </>
          ) : configuredRemote ? (
            <p role="status">{t('icloud.setupComplete')}</p>
          ) : null}
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
                defaultValue={profile?.timeout ?? 60000}
                min={1000}
                max={120000}
                name="timeout"
                type="number"
                required
              />
            </label>
          </details>
        </fieldset>
        {question ? (
          <section className="icloud-verification">
            <p role="status">
              {t(
                question.kind === 'phone'
                  ? 'icloud.choosePhone'
                  : question.kind === 'sms-code'
                    ? 'icloud.smsCodeHint'
                    : 'icloud.codeHint',
              )}
            </p>
            {question.retry ? <p role="alert">{t('icloud.retryCode')}</p> : null}
            <label>
              {t(question.kind === 'phone' ? 'icloud.phone' : 'icloud.verificationCode')}
              {question.kind === 'phone' ? (
                <select
                  value={answer}
                  disabled={isBusy || isCancelling}
                  onChange={(event) => setAnswer(event.currentTarget.value)}
                  required
                >
                  {question.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  key={question.kind}
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={answer}
                  onChange={(event) => setAnswer(event.currentTarget.value)}
                  pattern="[0-9]{4,10}"
                  minLength={4}
                  maxLength={10}
                  disabled={isBusy || isCancelling}
                  required
                />
              )}
            </label>
            {question.kind === 'verification-code' ? (
              <button
                type="button"
                disabled={isBusy || isCancelling}
                onClick={() => void continueSetup('sms')}
              >
                {t('icloud.sendSms')}
              </button>
            ) : null}
          </section>
        ) : null}
      </form>
    </Dialog>
  );
};
