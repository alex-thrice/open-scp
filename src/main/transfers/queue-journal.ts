import { z } from 'zod';
import { workspaceSnapshotSchema } from '@shared/ipc/workspace';
import type { TransferSnapshot } from '@shared/models/transfer-snapshot';
import type { ProfileStore } from '../persistence/profile-store';

const providerPath = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('ftp'), path: z.string().min(1) }),
  z.strictObject({ provider: z.literal('local'), path: z.string().min(1) }),
  z.strictObject({ provider: z.literal('sftp'), path: z.string().min(1) }),
  z.strictObject({ provider: z.literal('s3'), bucket: z.string(), key: z.string() }),
]);
const intentSchema = z.strictObject({
  sourcePath: providerPath,
  destinationPath: providerPath,
  sourceProfileId: z.string().optional(),
  destinationProfileId: z.string().optional(),
});
export type TransferIntent = z.infer<typeof intentSchema>;
export interface QueueRecord {
  readonly intent: TransferIntent;
  readonly snapshot: TransferSnapshot;
}
const recordSchema = z.strictObject({
  intent: intentSchema,
  snapshot: workspaceSnapshotSchema.shape.transfers.element.extend({
    transferredBytes: z.string().regex(/^\d+$/u).transform(BigInt),
    totalBytes: z.string().regex(/^\d+$/u).transform(BigInt),
  }),
});

export class QueueJournal {
  public constructor(private readonly store: ProfileStore) {}
  public load(): QueueRecord[] {
    const value = this.store.getSetting('transfer-queue-v1');
    if (!value) return [];
    return z.array(recordSchema).max(10000).parse(JSON.parse(value)) as QueueRecord[];
  }
  public save(records: readonly QueueRecord[]): void {
    this.store.setSetting(
      'transfer-queue-v1',
      JSON.stringify(records, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
