import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceRequest, WorkspaceSnapshot } from '@shared/ipc/workspace';

export const useWorkspaceService = (isActive: boolean) => {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({
    profiles: [],
    sessions: [],
    transfers: [],
    language: null,
  });
  const [initialized, setInitialized] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const response = await window.desktop.workspace({ action: 'snapshot' });
    if (response.ok) setSnapshot(response.data.snapshot);
    setInitialized(true);
  }, []);
  const run = useCallback(
    async (request: WorkspaceRequest) => {
      setErrorKey(null);
      const response = await window.desktop.workspace(request);
      if (response.ok) {
        setSnapshot(response.data.snapshot);
        return response.data;
      }
      setErrorKey(response.error.messageKey);
      await refresh();
      return undefined;
    },
    [refresh],
  );
  useEffect(() => {
    if (!isActive) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [isActive, refresh]);
  return { snapshot, run, errorKey, initialized };
};
export type WorkspaceRunner = ReturnType<typeof useWorkspaceService>['run'];
