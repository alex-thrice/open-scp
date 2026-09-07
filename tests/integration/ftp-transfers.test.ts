import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createFtpProviderPath,
  createLocalProviderPath,
} from '../../src/shared/models/provider-path';
import { createFtpFixtureProvider } from './ftp-harness';

describe('Local ↔ FTP transfers', () => {
  let localRoot: string;
  let remoteRoot: string;
  let local: LocalProvider;
  let fixture: ReturnType<typeof createFtpFixtureProvider>;
  let engine: TransferEngine;

  beforeEach(async () => {
    localRoot = await mkdtemp(join(tmpdir(), 'openscp-ftp-transfer-'));
    local = new LocalProvider({ rootPath: localRoot });
    await local.connect();
    fixture = createFtpFixtureProvider();
    await fixture.provider.connect();
    remoteRoot = `/data/transfer-${randomUUID()}`;
    await fixture.provider.createDirectory(createFtpProviderPath(remoteRoot));
    engine = new TransferEngine();
  });

  afterEach(async () => {
    engine.dispose();
    await fixture.provider.connect();
    await fixture.provider.delete(createFtpProviderPath(remoteRoot), { recursive: true });
    await fixture.provider.disconnect();
    await local.disconnect();
    await rm(localRoot, { recursive: true, force: true });
  });

  const wait = async (id: string, state: 'completed' | 'requiring-review' = 'completed') => {
    await vi.waitFor(
      () => {
        const item = engine.snapshots().find((entry) => entry.id === id);
        if (item?.state === 'failed') throw new Error(`Transfer failed: ${item.errorKey}`);
        expect(item?.state).toBe(state);
      },
      { timeout: 60000, interval: 20 },
    );
  };

  it('round-trips through the shared queue and asks only for a real conflict', async () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 0x66);
    const source = join(localRoot, 'ftp-roundtrip.bin');
    const destinationDirectory = join(localRoot, 'downloads');
    await writeFile(source, content);
    await mkdir(destinationDirectory);
    const upload = engine.enqueue({
      source: local,
      destination: fixture.provider,
      sourcePath: createLocalProviderPath(source),
      destinationPath: createFtpProviderPath(`${remoteRoot}/ftp-roundtrip.bin`),
      direction: 'upload',
      workspaceId: 'ftp-fixture',
      conflictPolicy: 'ask',
    });
    await wait(upload);
    const conflict = engine.enqueue({
      source: local,
      destination: fixture.provider,
      sourcePath: createLocalProviderPath(source),
      destinationPath: createFtpProviderPath(`${remoteRoot}/ftp-roundtrip.bin`),
      direction: 'upload',
      workspaceId: 'ftp-fixture',
      conflictPolicy: 'ask',
    });
    await wait(conflict, 'requiring-review');
    await engine.resolveConflict(conflict, 'skip', false);
    await wait(conflict);
    const download = engine.enqueue({
      source: fixture.provider,
      destination: local,
      sourcePath: createFtpProviderPath(`${remoteRoot}/ftp-roundtrip.bin`),
      destinationPath: createLocalProviderPath(join(destinationDirectory, 'ftp-roundtrip.bin')),
      direction: 'download',
      workspaceId: 'ftp-fixture',
      conflictPolicy: 'ask',
    });
    await wait(download);
    expect(await readFile(join(destinationDirectory, 'ftp-roundtrip.bin'))).toEqual(content);
    expect(
      (await fixture.provider.list(createFtpProviderPath(remoteRoot))).every(
        (entry) => !entry.name.startsWith('.openscp-part-'),
      ),
    ).toBe(true);
  });
});
