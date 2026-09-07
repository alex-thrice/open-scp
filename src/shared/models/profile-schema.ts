import { z } from 'zod';
import type { ConnectionProfile } from './connection-profile';

const secretReference = z.strictObject({
  id: z.string().uuid(),
  storage: z.literal('safe-storage'),
});
export const connectionProfileSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      kind: z.literal('sftp'),
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      username: z.string().min(1).max(200),
      initialDirectory: z.string().min(1).max(32768).optional(),
      timeout: z.number().int().min(1000).max(120000).optional(),
      keepalive: z.number().int().min(1000).max(120000).optional(),
      authentication: z.discriminatedUnion('method', [
        z.strictObject({ method: z.literal('agent') }),
        z.strictObject({ method: z.literal('password'), secret: secretReference }),
        z.strictObject({
          method: z.literal('private-key'),
          privateKeyPath: z.string().min(1).max(32768),
          passphrase: secretReference.optional(),
        }),
      ]),
    }),
    z.strictObject({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      kind: z.literal('ftp'),
      host: z
        .string()
        .trim()
        .min(1)
        .max(253)
        .refine((value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n')),
      port: z.number().int().min(1).max(65535),
      username: z
        .string()
        .min(1)
        .max(200)
        .refine((value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n')),
      initialDirectory: z
        .string()
        .min(1)
        .max(32768)
        .refine(
          (value) =>
            value.startsWith('/') &&
            !value.includes('\0') &&
            !value.includes('\r') &&
            !value.includes('\n'),
        )
        .optional(),
      timeout: z.number().int().min(1000).max(120000).optional(),
      authentication: z.strictObject({
        method: z.literal('password'),
        secret: secretReference,
      }),
    }),
    z.strictObject({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      kind: z.literal('s3'),
      initialPrefix: z.string().max(1024).optional(),
      accessKeyId: z.string().optional(),
      bucket: z.string().optional(),
      endpoint: z.string().optional(),
      forcePathStyle: z.boolean(),
      region: z.string(),
      secret: secretReference.optional(),
    }),
  ])
  .transform((profile): ConnectionProfile => {
    if (profile.kind === 's3')
      return {
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        forcePathStyle: profile.forcePathStyle,
        region: profile.region,
        ...(profile.initialPrefix === undefined ? {} : { initialPrefix: profile.initialPrefix }),
        ...(profile.accessKeyId === undefined ? {} : { accessKeyId: profile.accessKeyId }),
        ...(profile.bucket === undefined ? {} : { bucket: profile.bucket }),
        ...(profile.endpoint === undefined ? {} : { endpoint: profile.endpoint }),
        ...(profile.secret === undefined ? {} : { secret: profile.secret }),
      };
    if (profile.kind === 'ftp')
      return {
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        ...(profile.initialDirectory === undefined
          ? {}
          : { initialDirectory: profile.initialDirectory }),
        ...(profile.timeout === undefined ? {} : { timeout: profile.timeout }),
        authentication: profile.authentication,
      };
    const authentication = profile.authentication;
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      ...(profile.initialDirectory === undefined
        ? {}
        : { initialDirectory: profile.initialDirectory }),
      ...(profile.timeout === undefined ? {} : { timeout: profile.timeout }),
      ...(profile.keepalive === undefined ? {} : { keepalive: profile.keepalive }),
      authentication:
        authentication.method !== 'private-key'
          ? authentication
          : {
              method: 'private-key',
              privateKeyPath: authentication.privateKeyPath,
              ...(authentication.passphrase === undefined
                ? {}
                : { passphrase: authentication.passphrase }),
            },
    };
  });
