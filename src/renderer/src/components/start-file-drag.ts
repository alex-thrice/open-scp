import type { DragEvent } from 'react';
import type { FileDragRequest } from '@shared/ipc/file-drag';

export const startFileDrag = (
  event: DragEvent,
  request: FileDragRequest,
  onError: (messageKey: string) => void,
): boolean => {
  if (!window.desktop.startFileDrag) return false;
  event.preventDefault();
  event.stopPropagation();
  void window.desktop.startFileDrag(request).then(
    (result) => {
      if (!result.ok) onError(result.error.messageKey);
    },
    () => onError('errors.ipc.unavailable'),
  );
  return true;
};
