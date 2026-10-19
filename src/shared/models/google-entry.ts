import { z } from 'zod';

export const googleEntrySchema = z.strictObject({
  id: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  type: z.enum(['binary', 'folder', 'native', 'shortcut']),
  canDownload: z.boolean(),
  canCopy: z.boolean(),
  canWrite: z.boolean(),
  canRename: z.boolean(),
  canTrash: z.boolean(),
  canListChildren: z.boolean(),
  canAddChildren: z.boolean(),
});
export type GoogleEntry = z.infer<typeof googleEntrySchema>;
