import { z } from 'zod';
import { absoluteRemotePathSchema } from './absolute-remote-path';

export const mailruPathSchema = absoluteRemotePathSchema;

export const mailruProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  username: z.email().max(320),
  initialDirectory: mailruPathSchema,
  timeout: z.number().int().min(1000).max(120000),
});

export type MailruProfileDraft = z.infer<typeof mailruProfileDraftSchema>;
