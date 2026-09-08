import { z } from 'zod';

export const updateSettingsSchema = z.strictObject({
  automaticCheck: z.boolean(),
  automaticDownload: z.boolean(),
  automaticInstall: z.boolean(),
});
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

export const defaultUpdateSettings: UpdateSettings = {
  automaticCheck: true,
  automaticDownload: false,
  automaticInstall: false,
};

export const updateStateSchema = z.strictObject({
  supported: z.boolean(),
  currentVersion: z.string().min(1).max(100),
  availableVersion: z.string().min(1).max(100).nullable(),
  status: z.enum([
    'idle',
    'checking',
    'available',
    'not-available',
    'downloading',
    'downloaded',
    'error',
  ]),
  progress: z.number().min(0).max(100).nullable(),
  errorKey: z.string().nullable(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;
