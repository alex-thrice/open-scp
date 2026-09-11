import { z } from 'zod';

const filePathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine((path) => !path.includes('\0'));
export const dragPathsSchema = z.array(filePathSchema).min(1).max(100);
export const fileDragRequestSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('local'), paths: dragPathsSchema }),
  z.strictObject({ source: z.literal('prepared'), id: z.string().uuid() }),
]);
export type FileDragRequest = z.infer<typeof fileDragRequestSchema>;

export const externalDragSnapshotSchema = z.strictObject({
  id: z.string().uuid(),
  workspaceId: z.string().min(1).max(200),
  fileCount: z.number().int().positive(),
  state: z.enum(['preparing', 'ready', 'failed', 'cancelled']),
  transferredBytes: z.bigint().nonnegative(),
  totalBytes: z.bigint().nonnegative(),
  errorKey: z.string().nullable(),
});
export type ExternalDragSnapshot = z.infer<typeof externalDragSnapshotSchema>;
