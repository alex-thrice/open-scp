import { z } from 'zod';
import { absoluteRemotePathSchema } from './absolute-remote-path';

export const yandexPathSchema = absoluteRemotePathSchema;
export const yandexProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  initialDirectory: yandexPathSchema,
  timeout: z.number().int().min(1000).max(120000),
});
export type YandexProfileDraft = z.infer<typeof yandexProfileDraftSchema>;
