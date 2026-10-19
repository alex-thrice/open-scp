import { z } from 'zod';
import { absoluteRemotePathSchema } from './absolute-remote-path';

export const icloudRemoteSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[\p{L}\p{N}_.+@][\p{L}\p{N}_.+@ -]*$/u)
  .refine((value) => !value.endsWith(' ') && !/^[A-Za-z]$/u.test(value));
export const icloudProfileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  remote: icloudRemoteSchema,
  initialDirectory: absoluteRemotePathSchema,
  timeout: z.number().int().min(1000).max(120000),
});

export const icloudConfigurationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ id: z.string().uuid(), status: z.literal('complete') }),
  z.strictObject({ id: z.string().uuid(), status: z.literal('cancelled') }),
  z.strictObject({
    id: z.string().uuid(),
    status: z.literal('question'),
    kind: z.enum(['verification-code', 'sms-code', 'phone']),
    choices: z
      .array(z.strictObject({ value: z.string().max(128), label: z.string().max(200) }))
      .max(20),
    retry: z.boolean(),
  }),
]);
export type ICloudConfigurationResult = z.infer<typeof icloudConfigurationResultSchema>;
