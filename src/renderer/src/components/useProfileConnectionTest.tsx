import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import type { WorkspaceRunner } from './useWorkspaceService';

export const useProfileConnectionTest = (run: WorkspaceRunner, errorKey: string | null) => {
  const { t } = useTranslation();
  const [result, setResult] = useState<WorkspaceResult['connectionTest']>();
  const [profileId, setProfileId] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const generation = useRef(0);
  const testSubmission = useRef(false);
  const submitTest = (form: HTMLFormElement | null) => {
    testSubmission.current = true;
    try {
      form?.requestSubmit();
    } finally {
      testSubmission.current = false;
    }
  };
  const reset = () => {
    generation.current += 1;
    setResult(undefined);
  };
  const test = async (id: string, trustFingerprint?: string) => {
    const current = ++generation.current;
    setIsTesting(true);
    setResult(undefined);
    try {
      const response = await run({
        action: 'test-profile',
        profileId: id,
        ...(trustFingerprint ? { trustFingerprint } : {}),
      });
      if (current === generation.current) {
        setProfileId(id);
        setResult(response?.connectionTest);
      }
    } finally {
      setIsTesting(false);
    }
  };
  const feedback = errorKey ? (
    <p role="alert" className="connection-feedback connection-feedback--error">
      {t(errorKey)}
    </p>
  ) : result?.status === 'success' ? (
    <p role="status" className="connection-feedback connection-feedback--success">
      {t('connections.testSucceeded')}
    </p>
  ) : result?.status === 'host-key-required' ? (
    <div className="host-key">
      <p>{t('connections.unknownKey')}</p>
      <span>
        {result.host}:{result.port}
      </span>
      <code>{result.fingerprint}</code>
      <button
        disabled={isTesting}
        type="button"
        onClick={() => void test(profileId, result.fingerprint)}
      >
        {t('connections.trustAndTest')}
      </button>
    </div>
  ) : null;
  return {
    isTesting,
    test,
    reset,
    feedback,
    submitTest,
    isTestSubmission: () => testSubmission.current,
  };
};
