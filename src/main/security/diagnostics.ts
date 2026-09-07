import { serializeApplicationError } from '../ipc/application-error';
import { classifyTransferError } from '../transfers/reconnect-policy';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import { redact } from './redact';

export class Diagnostics {
  private readonly events: { at: string; code: string; category: string }[] = [];
  public record(error: unknown): void {
    this.events.push({
      at: new Date().toISOString(),
      code: serializeApplicationError(error).code,
      category: classifyTransferError(error),
    });
    if (this.events.length > 200) this.events.shift();
  }
  public report(snapshot: WorkspaceSnapshot): string {
    // Только разрешённые технические поля: без путей, профилей, хостов, сообщений SDK и stack traces.
    return JSON.stringify(
      redact({
        version: 1,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? null,
        node: process.versions.node,
        language: snapshot.language,
        profileCounts: {
          ftp: snapshot.profiles.filter((item) => item.kind === 'ftp').length,
          s3: snapshot.profiles.filter((item) => item.kind === 's3').length,
          sftp: snapshot.profiles.filter((item) => item.kind === 'sftp').length,
        },
        sessions: snapshot.sessions.map(({ kind, state }) => ({ kind, state })),
        transfers: snapshot.transfers.map(({ direction, state, errorCategory, reviewReason }) => ({
          direction,
          state,
          errorCategory,
          reviewReason,
        })),
        events: this.events,
      }),
      null,
      2,
    );
  }
}
