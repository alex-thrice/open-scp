import type { DragEvent } from 'react';
import { z } from 'zod';

const payload = z.strictObject({
  workspaceId: z.string().min(1).max(200),
  side: z.enum(['local', 'remote']),
  kind: z.enum(['ftp', 'local', 's3', 'sftp']),
  paths: z.array(z.string().min(1).max(32768)).min(1).max(1000),
});
export const readFileDrop = (event: DragEvent): z.infer<typeof payload> | undefined => {
  event.preventDefault();
  try {
    const internal = event.dataTransfer.getData('application/x-openscp');
    if (internal.length > 1048576) return undefined;
    if (internal) return payload.parse(JSON.parse(internal));
    const paths = [...event.dataTransfer.files]
      .map((file) => window.desktop.getPathForFile?.(file) ?? '')
      .filter(Boolean);
    return paths.length
      ? payload.parse({ workspaceId: 'external', side: 'local', kind: 'local', paths })
      : undefined;
  } catch {
    return undefined;
  }
};
