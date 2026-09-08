import { describe, expect, it, vi } from 'vitest';
import { workspaceRequestSchema, workspaceResultSchema } from '../../src/shared/ipc/workspace';
import { createDesktopApi } from '../../src/preload/desktop-api';
import { ipcRequestChannels } from '../../src/shared/ipc/channels';

describe('workspace IPC boundary', () => {
  it('validates themes and connection folder names at the boundary', () => {
    for (const name of ['', 'a/b', 'a\\b', 'bad\u0000name']) {
      expect(
        workspaceRequestSchema.safeParse({ action: 'create-profile-folder', name }).success,
      ).toBe(false);
    }
    expect(
      workspaceRequestSchema.safeParse({ action: 'create-profile-folder', name: 'Рабочие' })
        .success,
    ).toBe(true);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'set-appearance',
        appearance: { theme: 'system', density: 'compact', showHidden: false },
      }).success,
    ).toBe(true);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'set-appearance',
        appearance: { theme: 'unknown', density: 'compact', showHidden: false },
      }).success,
    ).toBe(false);
  });
  it('rejects arbitrary actions, malformed paths and unexpected secret fields', () => {
    expect(workspaceRequestSchema.safeParse({ action: 'exec', command: 'anything' }).success).toBe(
      false,
    );
    expect(
      workspaceRequestSchema.safeParse({ action: 'list', workspaceId: 'one', path: '/bad\0path' })
        .success,
    ).toBe(false);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'create-file',
        workspaceId: 'workspace:left',
        path: '/notes.txt',
      }).success,
    ).toBe(true);
    expect(
      workspaceRequestSchema.safeParse({ action: 'snapshot', password: 'fixture-only' }).success,
    ).toBe(false);
  });
  it('does not accept credentials in a workspace response', () => {
    expect(
      workspaceResultSchema.safeParse({
        snapshot: { profiles: [], sessions: [], transfers: [], language: null },
        listing: null,
        privateKeyPath: null,
        password: 'fixture-only',
      }).success,
    ).toBe(false);
  });
  it('exposes one fixed workspace channel and rejects malformed replies', async () => {
    const correlationId = '00000000-0000-4000-8000-000000000001';
    const invoke = vi.fn(async () => ({
      correlationId,
      ok: true,
      data: { secret: 'fixture-only' },
    }));
    const api = createDesktopApi({ invoke, subscribe: () => () => undefined }, () => correlationId);
    expect(await api.workspace({ action: 'snapshot' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_IPC_RESPONSE' },
    });
    expect(invoke).toHaveBeenCalledWith(ipcRequestChannels.workspace, {
      correlationId,
      payload: { action: 'snapshot' },
    });
  });
});
