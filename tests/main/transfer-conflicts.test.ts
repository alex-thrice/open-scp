// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import { createLocalProviderPath } from '../../src/shared/models/provider-path';

describe('deferred transfer conflicts', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('applies one decision once and an apply-to-all decision only within its job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-conflicts-'));
    roots.push(root);
    const sourcePath = join(root, 'source');
    const destinationDirectory = join(root, 'destination');
    const destinationPath = join(destinationDirectory, 'source');
    await mkdir(sourcePath);
    await mkdir(destinationPath, { recursive: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(sourcePath, name), `new-${name}`);
      await writeFile(join(destinationPath, name), `old-${name}`);
    }
    const provider = new LocalProvider({ rootPath: root });
    await provider.connect();
    const engine = new TransferEngine();
    const id = engine.enqueue({
      source: provider,
      destination: provider,
      sourcePath: createLocalProviderPath(sourcePath),
      destinationPath: createLocalProviderPath(destinationPath),
      workspaceId: 'workspace-1:left',
      direction: 'download',
      conflictPolicy: 'ask',
    });
    const waitForConflict = async (name: string) =>
      vi.waitFor(() =>
        expect(engine.snapshots()[0]?.conflictPath).toBe(join(destinationPath, name)),
      );

    await vi.waitFor(() => expect(engine.snapshots()[0]?.state).toBe('requiring-review'));
    await engine.resolveConflict(id, 'overwrite', false);
    await waitForConflict('a.txt');
    await engine.resolveConflict(id, 'skip', false);
    await waitForConflict('b.txt');
    await engine.resolveConflict(id, 'overwrite', true);
    await vi.waitFor(() => expect(engine.snapshots()[0]?.state).toBe('completed'));

    expect(await readFile(join(destinationPath, 'a.txt'), 'utf8')).toBe('old-a.txt');
    expect(await readFile(join(destinationPath, 'b.txt'), 'utf8')).toBe('new-b.txt');
    expect(await readFile(join(destinationPath, 'c.txt'), 'utf8')).toBe('new-c.txt');
    engine.dispose();
  });

  it('pauses when the destination appears during the final publish step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-conflict-race-'));
    roots.push(root);
    const sourcePath = join(root, 'source.txt');
    const destinationPath = join(root, 'target.txt');
    await writeFile(sourcePath, 'source content');
    const provider = new LocalProvider({ rootPath: root });
    await provider.connect();
    const rename = provider.rename.bind(provider);
    let raced = false;
    vi.spyOn(provider, 'rename').mockImplementation(async (...arguments_) => {
      if (!raced) {
        raced = true;
        await writeFile(destinationPath, 'concurrent content');
      }
      await rename(...arguments_);
    });
    const engine = new TransferEngine();
    const id = engine.enqueue({
      source: provider,
      destination: provider,
      sourcePath: createLocalProviderPath(sourcePath),
      destinationPath: createLocalProviderPath(destinationPath),
      workspaceId: 'workspace-1:left',
      direction: 'download',
      conflictPolicy: 'ask',
    });

    await vi.waitFor(() =>
      expect(engine.snapshots()[0]).toMatchObject({
        state: 'requiring-review',
        conflictPath: destinationPath,
      }),
    );
    expect(await readFile(destinationPath, 'utf8')).toBe('concurrent content');
    await engine.resolveConflict(id, 'rename', false);
    await vi.waitFor(() => expect(engine.snapshots()[0]?.state).toBe('completed'));
    expect(await readFile(destinationPath, 'utf8')).toBe('concurrent content');
    expect(await readFile(`${destinationPath} (1)`, 'utf8')).toBe('source content');
    engine.dispose();
  });
});
