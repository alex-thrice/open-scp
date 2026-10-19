import { z } from 'zod';

export const mailruPathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.includes('\\') &&
      ![...value].some((character) => character.charCodeAt(0) < 32 || character === '\x7f') &&
      value
        .replace(/\/$/u, '')
        .split('/')
        .slice(1)
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  );

export const mailruProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  username: z.email().max(320),
  initialDirectory: mailruPathSchema,
  timeout: z.number().int().min(1000).max(120000),
});

export type MailruProfileDraft = z.infer<typeof mailruProfileDraftSchema>;
