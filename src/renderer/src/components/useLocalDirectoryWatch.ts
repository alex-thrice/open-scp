import { useEffect, useRef } from 'react';

interface LocalDirectoryWatchOptions {
  readonly subscriptionId: string;
  readonly path: string | null;
  readonly isActive: boolean;
  readonly paused: boolean;
  readonly refresh: (isCurrent: () => boolean) => Promise<void>;
}

export const useLocalDirectoryWatch = ({
  subscriptionId,
  path,
  isActive,
  paused,
  refresh,
}: LocalDirectoryWatchOptions): void => {
  const refreshReference = useRef(refresh);
  const pausedReference = useRef(paused);
  const resumeReference = useRef<(() => void) | null>(null);
  const invalidateReference = useRef<(() => void) | null>(null);
  const previousActive = useRef(isActive);

  useEffect(() => {
    refreshReference.current = refresh;
  }, [refresh]);

  useEffect(() => {
    pausedReference.current = paused;
    resumeReference.current?.();
  }, [paused]);

  useEffect(() => {
    if (!isActive || path === null) return;
    let disposed = false;
    let dirty = false;
    let refreshing = false;
    const isCurrent = (): boolean => !disposed && !pausedReference.current;
    const drain = async (): Promise<void> => {
      if (!isCurrent() || refreshing || !dirty) return;
      dirty = false;
      refreshing = true;
      try {
        await refreshReference.current(isCurrent);
      } finally {
        refreshing = false;
        if (dirty && isCurrent()) void drain();
      }
    };
    const invalidate = (): void => {
      if (disposed) return;
      dirty = true;
      void drain();
    };
    const register = async (reconcileOnFailure: boolean): Promise<void> => {
      const response = await window.desktop.setLocalDirectoryWatch({ subscriptionId, path });
      if (response.ok || reconcileOnFailure || response.error.code.startsWith('PROVIDER_'))
        invalidate();
    };
    const onFocus = (): void => {
      void register(true);
    };
    const unsubscribe = window.desktop.onLocalDirectoryChanged((event) => {
      if (event.payload.subscriptionId === subscriptionId && event.payload.path === path)
        invalidate();
    });
    resumeReference.current = () => {
      if (refreshing && pausedReference.current) dirty = true;
      void drain();
    };
    invalidateReference.current = invalidate;
    window.addEventListener('focus', onFocus);
    void register(false);

    return () => {
      disposed = true;
      resumeReference.current = null;
      invalidateReference.current = null;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      void window.desktop.setLocalDirectoryWatch({ subscriptionId, path: null });
    };
  }, [isActive, path, subscriptionId]);

  useEffect(() => {
    if (isActive && !previousActive.current) invalidateReference.current?.();
    previousActive.current = isActive;
  }, [isActive]);
};
