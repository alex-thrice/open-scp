import { z } from 'zod';

const ftpText = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'));

export const ftpProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n')),
  port: z.number().int().min(1).max(65535),
  username: ftpText.max(200),
  initialDirectory: ftpText.refine((value) => value.startsWith('/')),
  timeout: z.number().int().min(1000).max(120000),
});

export type FtpProfileDraft = z.infer<typeof ftpProfileDraftSchema>;
