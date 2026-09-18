import { z } from 'zod';

export const transferSettingsSchema = z.strictObject({
  sftpUploadConcurrency: z.number().int().min(1).max(128),
  sftpDownloadConcurrency: z.number().int().min(1).max(128),
});

export type TransferSettings = z.infer<typeof transferSettingsSchema>;

export const defaultTransferSettings: Readonly<TransferSettings> = Object.freeze({
  sftpUploadConcurrency: 64,
  sftpDownloadConcurrency: 32,
});

export const readTransferSettings = (value: string | undefined): TransferSettings => {
  try {
    const parsed = transferSettingsSchema.safeParse(JSON.parse(value ?? 'null'));
    return parsed.success ? parsed.data : defaultTransferSettings;
  } catch {
    return defaultTransferSettings;
  }
};
