import { z } from 'zod';
import { absoluteRemotePathSchema } from './absolute-remote-path';
import { icloudRemoteSchema } from './icloud-profile';

export const googleProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  remote: icloudRemoteSchema,
  initialDirectory: absoluteRemotePathSchema,
  timeout: z.number().int().min(1000).max(120000),
});
export type GoogleProfileDraft = z.infer<typeof googleProfileDraftSchema>;
