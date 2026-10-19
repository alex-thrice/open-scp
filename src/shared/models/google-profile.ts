import { z } from 'zod';
import { googleDirectoryPathSchema } from './google-path';

export const googleProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  initialDirectory: googleDirectoryPathSchema,
  timeout: z.number().int().min(1000).max(120000),
});
export type GoogleProfileDraft = z.infer<typeof googleProfileDraftSchema>;
