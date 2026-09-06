import type {
  EmptyIpcRequest,
  IpcRequestEnvelope,
  LocalDirectoryListing,
  LocalDirectoryRequest,
  LocalDrive,
  RuntimeInfo,
  RuntimePlatform,
} from '@shared/ipc/contracts';
import { z } from 'zod';

export const correlationIdSchema = z.string().uuid();

export const runtimePlatformSchema: z.ZodType<RuntimePlatform> = z.enum([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);

export const runtimeInfoRequestSchema: z.ZodType<IpcRequestEnvelope<EmptyIpcRequest>> =
  z.strictObject({
    correlationId: correlationIdSchema,
    payload: z.strictObject({}),
  });

export const runtimeInfoResponseSchema: z.ZodType<RuntimeInfo> = z.strictObject({
  platform: runtimePlatformSchema,
  runtime: z.literal('electron'),
});

const localPathSchema = z.string().min(1).max(32_768);

export const localDrivesRequestSchema = runtimeInfoRequestSchema;

export const localDrivesResponseSchema: z.ZodType<readonly LocalDrive[]> = z.array(
  z.strictObject({
    icon: z
      .string()
      .max(131072)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u)
      .optional(),
    label: z.string().min(1).max(32_768),
    path: localPathSchema,
  }),
);

export const localDirectoryRequestSchema: z.ZodType<IpcRequestEnvelope<LocalDirectoryRequest>> =
  z.strictObject({
    correlationId: correlationIdSchema,
    payload: z.strictObject({
      path: localPathSchema.nullable(),
    }),
  });

export const localDirectoryResponseSchema: z.ZodType<LocalDirectoryListing> = z.strictObject({
  breadcrumbs: z.array(
    z.strictObject({
      label: z.string().min(1).max(32_768),
      path: localPathSchema,
    }),
  ),
  currentPath: localPathSchema,
  entries: z.array(
    z.strictObject({
      kind: z.enum(['directory', 'file', 'special', 'symbolic-link']),
      modifiedAt: z.string().datetime().nullable(),
      name: z.string().min(1).max(32_768),
      path: localPathSchema,
      size: z.bigint().nonnegative(),
    }),
  ),
  parentPath: localPathSchema.nullable(),
});
