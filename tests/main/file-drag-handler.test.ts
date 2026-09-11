// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFileDragHandler } from '../../src/main/ipc/file-drag-handler';

const correlationId = '00000000-0000-4000-8000-000000000001';
describe('native file drag IPC', () => {
  it('hands validated files to the native drag operation', async () => {
    const filesForDrag = vi.fn(async () => ['/fixture/one.txt', '/fixture/two.txt']);
    const startDrag = vi.fn(async () => undefined);
    const handle = createFileDragHandler({ isAllowed: () => true, filesForDrag, startDrag });
    const payload = { source: 'local', paths: ['/fixture/one.txt', '/fixture/two.txt'] };
    expect(await handle({ correlationId, payload })).toEqual({
      correlationId,
      ok: true,
      data: null,
    });
    expect(filesForDrag).toHaveBeenCalledWith(payload);
    expect(startDrag).toHaveBeenCalledWith(payload.paths);
  });

  it('rejects untrusted senders, malformed paths and excessive selections', async () => {
    const filesForDrag = vi.fn(async () => ['/fixture/one.txt']);
    const startDrag = vi.fn(async () => undefined);
    const isAllowed = vi.fn(() => false);
    const handle = createFileDragHandler({ isAllowed, filesForDrag, startDrag });
    expect(
      await handle({ correlationId, payload: { source: 'local', paths: ['/fixture/one.txt'] } }),
    ).toMatchObject({ ok: false });
    isAllowed.mockReturnValue(true);
    for (const paths of [[], ['bad\0path'], Array.from({ length: 101 }, () => '/file')])
      expect(await handle({ correlationId, payload: { source: 'local', paths } })).toMatchObject({
        ok: false,
      });
    expect(filesForDrag).not.toHaveBeenCalled();
    expect(startDrag).not.toHaveBeenCalled();
  });

  it('rechecks the sender after resolving files', async () => {
    const isAllowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const startDrag = vi.fn(async () => undefined);
    const handle = createFileDragHandler({
      isAllowed,
      filesForDrag: async () => ['/fixture/one.txt'],
      startDrag,
    });
    expect(
      await handle({ correlationId, payload: { source: 'prepared', id: correlationId } }),
    ).toMatchObject({ ok: false });
    expect(startDrag).not.toHaveBeenCalled();
  });
});
