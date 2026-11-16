// @vitest-environment node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleProvider } from '../../src/main/providers/google/google-provider';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createGoogleProviderPath as path,
  createLocalProviderPath as localPath,
} from '../../src/shared/models/provider-path';
import { startGoogleFixture } from '../fixtures/google-fixture';

describe('Google rclone shared transfer queue', () => {
  let fixture: Awaited<ReturnType<typeof startGoogleFixture>>;
  let google: GoogleProvider;
  let local: LocalProvider;
  let engine: TransferEngine;
  let root: string;
  beforeEach(async () => {
    fixture = await startGoogleFixture();
    google = fixture.create();
    root = join(fixture.root, 'local');
    await mkdir(root);
    local = new LocalProvider({ rootPath: root });
    engine = new TransferEngine();
    await google.connect();
    await local.connect();
  });
  afterEach(async () => {
    engine.dispose();
    await google.disconnect();
    await local.disconnect();
    await fixture.close();
  });
  const wait = (id: string) =>
    vi.waitFor(
      () => {
        const snapshot = engine.snapshots().find((item) => item.id === id);
        expect(snapshot?.state, snapshot?.errorKey ?? '').toBe('completed');
      },
      { timeout: 15000, interval: 20 },
    );
  const upload = (name: string, policy: 'ask' | 'overwrite' | 'rename' | 'skip' = 'ask') =>
    engine.enqueue({
      source: local,
      destination: google,
      sourcePath: localPath(join(root, name)),
      destinationPath: path(`/${name}`),
      workspaceId: 'local',
      direction: 'upload',
      conflictPolicy: policy,
    });

  it('round-trips nested Unicode names, empty directories and streamed binary data', async () => {
    await mkdir(join(root, 'source', 'empty'), { recursive: true });
    await writeFile(join(root, 'source', 'Привет #%&.txt'), 'Unicode content');
    await writeFile(join(root, 'source', 'zero'), '');
    const content = Buffer.alloc(4 * 1048576 + 13, 0x5a);
    await writeFile(join(root, 'source', 'large.bin'), content);
    await wait(upload('source'));
    await wait(
      engine.enqueue({
        source: google,
        destination: local,
        sourcePath: path('/source'),
        destinationPath: localPath(join(root, 'returned')),
        workspaceId: 'google',
        direction: 'download',
        conflictPolicy: 'ask',
      }),
    );
    expect((await readFile(join(root, 'returned', 'large.bin'))).equals(content)).toBe(true);
    expect(await readFile(join(root, 'returned', 'zero'))).toHaveLength(0);
    expect(await readFile(join(root, 'returned', 'Привет #%&.txt'), 'utf8')).toBe(
      'Unicode content',
    );
    expect(await google.list(path('/source/empty'))).toEqual([]);
  }, 60000);

  it('handles conflict policies and repeat copies after renaming or deleting a previous result', async () => {
    await writeFile(join(root, 'file.txt'), 'new');
    await writeFile(join(fixture.root, 'google', 'file.txt'), 'old');
    await wait(upload('file.txt', 'skip'));
    expect(await readFile(join(fixture.root, 'google', 'file.txt'), 'utf8')).toBe('old');
    await wait(upload('file.txt', 'overwrite'));
    expect(await readFile(join(fixture.root, 'google', 'file.txt'), 'utf8')).toBe('new');
    await google.rename(path('/file.txt'), path('/renamed.txt'));
    await wait(upload('file.txt'));
    await google.delete(path('/file.txt'), { recursive: false });
    await wait(upload('file.txt'));
    await wait(upload('file.txt', 'rename'));
    expect((await google.list(path('/'))).filter((entry) => entry.kind === 'file')).toHaveLength(3);
  }, 30000);

  it('copies through separate Google remotes using the common streaming queue', async () => {
    const other = fixture.create('google-work');
    try {
      await other.connect();
      await writeFile(join(fixture.root, 'google', 'source.txt'), 'personal content');
      await writeFile(join(fixture.root, 'google-work', 'source.txt'), 'work content');
      await wait(
        engine.enqueue({
          source: google,
          destination: other,
          sourcePath: path('/source.txt'),
          destinationPath: path('/copied.txt'),
          workspaceId: 'personal',
          destinationWorkspaceId: 'work',
          direction: 'remote',
          conflictPolicy: 'ask',
        }),
      );
      expect(await readFile(join(fixture.root, 'google-work', 'copied.txt'), 'utf8')).toBe(
        'personal content',
      );
      expect(await readFile(join(fixture.root, 'google-work', 'source.txt'), 'utf8')).toBe(
        'work content',
      );
    } finally {
      await other.disconnect();
    }
  });

  it.each(['same-root', 'nested-root', 'root-source'] as const)(
    'stops recursive self-copy through two Google remotes with %s aliases',
    async (mode) => {
      await mkdir(join(fixture.root, 'google', 'source', 'subdir'), { recursive: true });
      await writeFile(join(fixture.root, 'google', 'source', 'subdir', 'original.txt'), 'original');
      await fixture.behavior({
        remoteRoots: { 'google-work': mode === 'nested-root' ? 'google/source/subdir' : 'google' },
      });
      const alias = fixture.create('google-work');
      try {
        await alias.connect();
        const id = engine.enqueue({
          source: google,
          destination: alias,
          sourcePath: path(mode === 'root-source' ? '/' : '/source'),
          destinationPath: path(mode === 'same-root' ? '/source/subdir/copied' : '/copied'),
          workspaceId: 'source',
          destinationWorkspaceId: 'alias',
          direction: 'remote',
          conflictPolicy: 'ask',
        });
        await vi.waitFor(
          () => expect(engine.snapshots().find((item) => item.id === id)?.state).toBe('failed'),
          { timeout: 15000, interval: 20 },
        );
        expect(
          await readFile(join(fixture.root, 'google', 'source', 'subdir', 'original.txt'), 'utf8'),
        ).toBe('original');
        if (mode === 'same-root')
          expect(await readdir(join(fixture.root, 'google', 'source', 'subdir'))).toEqual([
            'original.txt',
          ]);
        else if (mode === 'nested-root')
          expect(
            await readdir(join(fixture.root, 'google', 'source', 'subdir', 'copied', 'subdir')),
          ).toEqual([]);
        else expect(await readdir(join(fixture.root, 'google', 'copied'))).toEqual([]);
      } finally {
        await alias.disconnect();
      }
    },
    30000,
  );

  it('rejects overwriting a Google file through another name for the same remote root', async () => {
    await writeFile(join(fixture.root, 'google', 'original.txt'), 'original');
    await fixture.behavior({ remoteRoots: { 'google-work': 'google' } });
    const alias = fixture.create('google-work');
    try {
      await alias.connect();
      const id = engine.enqueue({
        source: google,
        destination: alias,
        sourcePath: path('/original.txt'),
        destinationPath: path('/original.txt'),
        workspaceId: 'source',
        destinationWorkspaceId: 'alias',
        direction: 'remote',
        conflictPolicy: 'overwrite',
      });
      await vi.waitFor(
        () => expect(engine.snapshots().find((item) => item.id === id)?.state).toBe('failed'),
        { timeout: 15000, interval: 20 },
      );
      expect(await readFile(join(fixture.root, 'google', 'original.txt'), 'utf8')).toBe('original');
      expect(fixture.commands.some((args) => args[0] === 'rcat')).toBe(false);
    } finally {
      await alias.disconnect();
    }
  });
});
