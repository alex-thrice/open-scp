import { z } from 'zod';
import { connectionProfileSchema } from '@shared/models/profile-schema';
import { s3ProfileDraftSchema } from '@shared/models/s3-profile';
import { ftpProfileDraftSchema } from '@shared/models/ftp-profile';

const id = z.string().min(1).max(200);
const workspaceId = z.string().regex(/^workspace-[1-9]\d{0,3}$/u);
const path = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes('\0'));
const policy = z.enum(['ask', 'fail', 'overwrite', 'skip', 'rename']);
export const appearanceSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'system']),
  density: z.enum(['comfortable', 'compact']),
  showHidden: z.boolean(),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaultAppearance: Appearance = {
  theme: 'light',
  density: 'comfortable',
  showHidden: true,
};
export const workspaceLayoutSchema = z.strictObject({
  activeWorkspaceId: workspaceId,
  workspaceIds: z.array(workspaceId).min(1).max(100),
});
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export const profileDraftSchema = z.strictObject({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(200),
  authMode: z.enum(['password', 'private-key', 'agent']),
  privateKeyPath: z.string().max(32768),
  initialDirectory: path,
  timeout: z.number().int().min(1000).max(120000),
  keepalive: z.number().int().min(1000).max(120000),
});
export type ProfileDraft = z.infer<typeof profileDraftSchema>;
export const workspaceRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set-appearance'), appearance: appearanceSchema }),
  z.strictObject({
    action: z.literal('create-profile-folder'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^/\\]+$/u)
      .refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32)),
  }),
  z.strictObject({ action: z.literal('clear-transfer-history') }),
  z.strictObject({ action: z.literal('open-local-file'), workspaceId: id, path }),
  z.strictObject({ action: z.literal('edit-file'), workspaceId: id, path }),
  z.strictObject({ action: z.literal('open-ssh-terminal'), workspaceId: id }),
  z.strictObject({ action: z.literal('set-editor-path'), path: path.nullable() }),
  z.strictObject({ action: z.literal('set-putty-path'), path: path.nullable() }),
  z.strictObject({ action: z.literal('set-remember-paths'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('remember-workspace-layout'), layout: workspaceLayoutSchema }),
  z.strictObject({ action: z.literal('remember-local-path'), workspaceId: id, path }),
  z.strictObject({
    action: z.literal('local-transfer'),
    workspaceId: id,
    sourcePath: path,
    destinationDirectory: path,
    conflictPolicy: policy,
  }),
  z.strictObject({
    action: z.literal('local-operation'),
    workspaceId: id,
    operation: z.enum(['mkdir', 'rename', 'delete']),
    path,
    destinationPath: path.optional(),
  }),
  z.strictObject({
    action: z.literal('clone-profile'),
    profileId: id,
    name: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    action: z.literal('set-profile-group'),
    profileId: id,
    group: z.string().trim().max(100),
  }),
  z.strictObject({ action: z.literal('export-profiles') }),
  z.strictObject({ action: z.literal('import-profiles'), content: z.string().max(1048576) }),
  z.strictObject({ action: z.literal('import-known-hosts'), content: z.string().max(1048576) }),
  z.strictObject({ action: z.literal('export-diagnostics') }),
  z.strictObject({ action: z.literal('save-export'), kind: z.enum(['profiles', 'diagnostics']) }),
  z.strictObject({
    action: z.literal('close-session'),
    workspaceId: id,
    cancelActive: z.literal(true),
  }),
  z.strictObject({
    action: z.literal('remote-transfer'),
    workspaceId: id,
    destinationWorkspaceId: id,
    sourcePath: path,
    destinationDirectory: path,
    conflictPolicy: policy,
  }),
  z.strictObject({
    action: z.literal('save-s3-profile'),
    profile: s3ProfileDraftSchema,
    secretAccessKey: z.string().min(1).max(65536).optional(),
    sessionToken: z.string().max(65536).optional(),
  }),
  z.strictObject({
    action: z.literal('save-ftp-profile'),
    profile: ftpProfileDraftSchema,
    password: z.string().max(65536).optional(),
  }),
  z.strictObject({ action: z.literal('preview-delete'), workspaceId: id, path }),
  z.strictObject({ action: z.literal('copy'), workspaceId: id, path, destinationPath: path }),
  z.strictObject({ action: z.literal('cleanup-multipart'), profileId: id }),
  z.strictObject({ action: z.literal('snapshot') }),
  z.strictObject({
    action: z.literal('save-profile'),
    profile: profileDraftSchema,
    secret: z.string().max(65536).optional(),
  }),
  z.strictObject({ action: z.literal('delete-profile'), profileId: id }),
  z.strictObject({ action: z.literal('connect'), workspaceId: id, profileId: id }),
  z.strictObject({ action: z.literal('cancel-connect'), workspaceId: id }),
  z.strictObject({
    action: z.literal('provide-password'),
    workspaceId: id,
    password: z.string().min(1).max(65536),
    save: z.boolean(),
  }),
  z.strictObject({ action: z.literal('disconnect'), workspaceId: id }),
  z.strictObject({
    action: z.literal('trust-host'),
    workspaceId: id,
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
  }),
  z.strictObject({ action: z.literal('list'), workspaceId: id, path: path.nullable() }),
  z.strictObject({ action: z.literal('mkdir'), workspaceId: id, path }),
  z.strictObject({ action: z.literal('rename'), workspaceId: id, path, destinationPath: path }),
  z.strictObject({
    action: z.literal('delete'),
    workspaceId: id,
    path,
    recursive: z.boolean(),
    confirmationId: z.string().uuid().optional(),
  }),
  z.strictObject({
    action: z.literal('transfer'),
    workspaceId: id,
    direction: z.enum(['upload', 'download']),
    sourcePath: path,
    destinationDirectory: path,
    conflictPolicy: policy,
  }),
  z.strictObject({ action: z.literal('cancel-transfer'), id }),
  z.strictObject({ action: z.literal('retry-transfer'), id, resume: z.boolean() }),
  z.strictObject({
    action: z.literal('resolve-conflict'),
    id,
    policy,
    applyToAll: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('resolve-external-edit'),
    id,
    resolution: z.enum(['upload', 'overwrite', 'discard']),
  }),
  z.strictObject({ action: z.literal('pick-private-key') }),
  z.strictObject({ action: z.literal('set-language'), language: z.enum(['en', 'ru']) }),
]);
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
const entrySchema = z.strictObject({
  s3Kind: z.enum(['bucket', 'prefix', 'object']).optional(),
  kind: z.enum(['file', 'directory', 'symbolic-link', 'special']),
  modifiedAt: z.string().nullable(),
  name: z.string(),
  path,
  size: z.bigint().nonnegative(),
  permissions: z.number().int().nonnegative().nullable(),
});
export const remoteListingSchema = z.strictObject({
  breadcrumbs: z.array(z.strictObject({ label: z.string(), path })),
  currentPath: path,
  entries: z.array(entrySchema),
  parentPath: path.nullable(),
});
export type RemoteDirectoryListing = z.infer<typeof remoteListingSchema>;
export const workspaceSnapshotSchema = z.strictObject({
  appearance: appearanceSchema.optional(),
  editorPath: path.nullable().optional(),
  puttyPath: path.nullable().optional(),
  rememberPaths: z.boolean().optional(),
  workspaceLayout: workspaceLayoutSchema.optional(),
  localPathHistory: z.record(z.string(), path).optional(),
  localPaths: z.record(z.string(), path).optional(),
  profileFolders: z.array(z.string().max(100)).max(1000).optional(),
  profileGroups: z.record(z.string(), z.string()).optional(),
  recentPaths: z.record(z.string(), z.array(path).max(20)).optional(),
  cleanups: z
    .array(z.strictObject({ profileId: id, count: z.number().int().nonnegative() }))
    .optional(),
  profiles: z.array(connectionProfileSchema),
  language: z.enum(['en', 'ru']).nullable(),
  sessions: z.array(
    z.strictObject({
      workspaceId: id,
      profileId: id,
      kind: z.enum(['ftp', 'sftp', 's3']).optional(),
      name: z.string(),
      state: z.enum(['connected', 'connecting', 'disconnected', 'disconnecting', 'failed']),
      connectionStage: z
        .enum([
          'authenticating',
          'cancelled',
          'connected',
          'connecting',
          'failed',
          'handshaking',
          'loading-directory',
          'negotiating',
          'opening-sftp',
          'resolving-credentials',
          'starting',
          'verifying-host-key',
        ])
        .optional(),
      connectionErrorKey: z.string().nullable().optional(),
      passwordRequired: z.boolean().optional(),
      insecure: z.boolean().optional(),
      pathFallback: z.boolean().optional(),
      hostKey: z.strictObject({ fingerprint: z.string(), changed: z.boolean() }).nullable(),
      currentPath: path.optional(),
      capabilities: z
        .strictObject({
          read: z.boolean(),
          write: z.boolean(),
          rename: z.boolean(),
          delete: z.boolean(),
          createDirectory: z.boolean(),
          serverSideCopy: z.boolean(),
        })
        .optional(),
    }),
  ),
  transfers: z.array(
    z.strictObject({
      id,
      workspaceId: id,
      sourcePath: path,
      destinationPath: path,
      direction: z.enum(['upload', 'download', 'remote']),
      destinationWorkspaceId: id.optional(),
      reviewReason: z.enum(['restart', 'uncertain']).optional(),
      errorCategory: z.enum(['transient', 'auth', 'conflict', 'permanent']).optional(),
      state: z.enum([
        'cancelled',
        'completed',
        'failed',
        'paused',
        'queued',
        'requiring-review',
        'running',
      ]),
      conflictPolicy: policy,
      transferredBytes: z.bigint().nonnegative(),
      totalBytes: z.bigint().nonnegative(),
      speed: z.number().nonnegative(),
      elapsed: z.number().nonnegative(),
      remaining: z.number().nonnegative().nullable(),
      errorKey: z.string().nullable(),
      conflictPath: path.nullable(),
      conflictSourcePath: path.nullable().optional(),
    }),
  ),
  externalEdits: z
    .array(
      z.strictObject({
        id,
        workspaceId: id,
        fileName: z.string().min(1).max(1024),
        remotePath: path,
        state: z.enum(['changed', 'conflict', 'failed', 'recovered', 'uploading', 'watching']),
        errorKey: z.string().nullable(),
      }),
    )
    .optional(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export const workspaceResultSchema = z.strictObject({
  savedProfileId: id.optional(),
  document: z.string().max(2097152).optional(),
  importSummary: z
    .strictObject({
      imported: z.number().int(),
      skipped: z.number().int(),
      conflicts: z.number().int(),
    })
    .optional(),
  deletion: z
    .strictObject({
      confirmationId: z.string().uuid(),
      count: z.number().int().nonnegative(),
      bytes: z.bigint().nonnegative(),
    })
    .optional(),
  snapshot: workspaceSnapshotSchema,
  listing: remoteListingSchema.nullable(),
  privateKeyPath: path.nullable(),
});
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;
