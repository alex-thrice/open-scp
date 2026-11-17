import { z } from 'zod';
import { profileDraftSchema } from '../ipc/workspace';
import { s3ProfileDraftSchema } from './s3-profile';
import { ftpProfileDraftSchema } from './ftp-profile';
import { mailruProfileDraftSchema } from './mailru-profile';
import { googleProfileDraftSchema } from './google-profile';
import { yandexProfileDraftSchema } from './yandex-profile';
import { icloudProfileDraftSchema } from './icloud-profile';
import { googleDirectoryPathSchema } from './google-path';

const googleArchiveProfileSchema = googleProfileDraftSchema.extend({
  remote: googleProfileDraftSchema.shape.remote.optional(),
  initialDirectory: z.union([
    googleProfileDraftSchema.shape.initialDirectory,
    googleDirectoryPathSchema.transform(() => '/'),
  ]),
});

export const profileArchiveSchema = z.strictObject({
  version: z.literal(1),
  folders: z.array(z.string().min(1).max(100)).max(1000).optional(),
  profiles: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('icloud'),
          profile: icloudProfileDraftSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
        z.strictObject({
          kind: z.literal('google'),
          profile: googleArchiveProfileSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
        z.strictObject({
          kind: z.literal('yandex'),
          profile: yandexProfileDraftSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
        z.strictObject({
          kind: z.literal('mailru'),
          profile: mailruProfileDraftSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
        z.strictObject({
          kind: z.literal('ftp'),
          profile: ftpProfileDraftSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
        z.strictObject({
          kind: z.literal('sftp'),
          profile: profileDraftSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
        z.strictObject({
          kind: z.literal('s3'),
          profile: s3ProfileDraftSchema.refine((profile) => profile.id === null),
          group: z.string().max(100),
        }),
      ]),
    )
    .max(1000),
});
