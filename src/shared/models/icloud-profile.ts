import { z } from 'zod';
import { absoluteRemotePathSchema } from './absolute-remote-path';

export const icloudRemoteSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u);
export const icloudProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  remote: icloudRemoteSchema,
  initialDirectory: absoluteRemotePathSchema,
  timeout: z.number().int().min(1000).max(120000),
});
