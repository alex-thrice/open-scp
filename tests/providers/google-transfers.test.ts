// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleHarness, required } from '../fixtures/google-harness';
import { googleFixtureEntry } from '../fixtures/google-fixture';
import { GoogleProvider } from '../../src/main/providers/google/google-provider';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createGoogleProviderPath as path,
  createLocalProviderPath as localPath,
} from '../../src/shared/models/provider-path';
import {
  googleChildPath,
  googleExportPath,
  googleRootPath,
} from '../../src/shared/models/google-path';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { workspaceRequestSchema } from '../../src/shared/ipc/workspace';

describe('Google Drive shared queue and workspace', () => {
  let harness: Awaited<ReturnType<typeof createGoogleHarness>>;
  let google: GoogleProvider;
  let engine: TransferEngine;
  let root: string;
  let local: LocalProvider;
  beforeEach(async () => {
    harness = await createGoogleHarness();
    await harness.authorize();
    google = harness.provider();
    await google.connect();
    engine = new TransferEngine();
    root = await mkdtemp(join(tmpdir(), 'openscp-google-'));
    local = new LocalProvider({ rootPath: root });
    await local.connect();
  });
  afterEach(async () => {
    engine.dispose();
    await google.disconnect();
    await local.disconnect();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });
  const wait = (id: string, state = 'completed') =>
    vi.waitFor(
      () => {
        const snapshot = engine.snapshots().find((item) => item.id === id);
        expect(snapshot?.state, snapshot?.errorKey ?? '').toBe(state);
      },
      { timeout: 10000, interval: 10 },
    );
  const upload = (name: string, policy: 'ask' | 'overwrite' | 'rename' = 'ask') =>
    engine.enqueue({
      source: local,
      destination: google,
      sourcePath: localPath(join(root, name)),
      destinationPath: path(googleChildPath(googleRootPath, name)),
      workspaceId: 'source',
      direction: 'upload',
      conflictPolicy: policy,
    });
  it('asks before publishing when a same-name file appears during upload, then restarts to a new name', async () => {
    await writeFile(join(root, 'race'), Buffer.alloc(2 * 1048576 + 1, 0x37));
    const competing = googleFixtureEntry('race', 'other client');
    harness.fixture.afterChunk = () => {
      harness.fixture.afterChunk = undefined;
      required(harness.fixture.accounts.get('one')).set(competing.id, competing);
    };
    const id = upload('race');
    await wait(id, 'requiring-review');
    await engine.resolveConflict(id, 'rename', false);
    await wait(id);
    expect(competing.content.toString()).toBe('other client');
    expect((await google.list(path(googleRootPath))).map((entry) => entry.name)).toEqual([
      'race',
      'race (1)',
    ]);
  });
  it('requires a result review after losing the final response and does not create a duplicate', async () => {
    await writeFile(join(root, 'uncertain'), 'payload');
    harness.fixture.loseCompletionOnce = true;
    const id = upload('uncertain');
    await wait(id, 'requiring-review');
    expect(engine.snapshots()[0]?.reviewReason).toBe('uncertain');
    await engine.retry(id, false);
    await wait(id, 'requiring-review');
    expect(engine.snapshots()[0]?.conflictPath).toBe(googleChildPath(googleRootPath, 'uncertain'));
    expect(
      (await google.list(path(googleRootPath))).filter((entry) => entry.name === 'uncertain'),
    ).toHaveLength(1);
    expect(harness.fixture.sessions.size).toBe(1);
  });
  it('requires restart when the source cannot be reopened with a safe offset', async () => {
    Object.defineProperty(local, 'capabilities', {
      value: { ...local.capabilities, resumeRead: false },
    });
    await writeFile(join(root, 'restart'), Buffer.alloc(2 * 1048576 + 1));
    let id = '';
    harness.fixture.afterChunk = () => {
      harness.fixture.afterChunk = undefined;
      engine.cancel(id);
    };
    id = upload('restart');
    await wait(id, 'cancelled');
    await engine.retry(id, true);
    await wait(id, 'failed');
    expect(engine.snapshots()[0]?.errorKey).toBe('errors.transfer.unsafeResume');
    await engine.retry(id, false);
    await wait(id);
  });
  it('round-trips nested Unicode, empty and 32 MiB files through the common queue', async () => {
    await mkdir(join(root, 'tree', 'empty'), { recursive: true });
    await writeFile(join(root, 'tree', 'Привет #~?.txt').replace('?', ''), 'unicode');
    await writeFile(join(root, 'tree', 'zero'), '');
    const content = Buffer.alloc(32 * 1048576 + 31, 0x7a);
    await writeFile(join(root, 'tree', 'big'), content);
    await wait(upload('tree'));
    const tree = await google.stat(path(googleChildPath(googleRootPath, 'tree')));
    const id = engine.enqueue({
      source: google,
      destination: local,
      sourcePath: tree.path,
      destinationPath: localPath(join(root, 'returned')),
      workspaceId: 'source',
      direction: 'download',
      conflictPolicy: 'ask',
    });
    await wait(id);
    expect((await readFile(join(root, 'returned', 'big'))).equals(content)).toBe(true);
    expect(await readFile(join(root, 'returned', 'zero'))).toHaveLength(0);
    expect(await readFile(join(root, 'returned', 'Привет #~.txt'), 'utf8')).toBe('unicode');
    expect(engine.snapshots().every((item) => item.transferredBytes === item.totalBytes)).toBe(
      true,
    );
  }, 20000);
  it('requires an exact ID when overwriting duplicate names and rejects a forged choice', async () => {
    await writeFile(join(root, 'same'), 'new');
    const tree = required(harness.fixture.accounts.get('one'));
    const first = googleFixtureEntry('same', 'first');
    const second = googleFixtureEntry('same', 'second');
    tree.set(first.id, first);
    tree.set(second.id, second);
    const id = upload('same', 'overwrite');
    await wait(id, 'requiring-review');
    expect(engine.snapshots()[0]?.conflictCandidates).toHaveLength(2);
    await expect(
      engine.resolveConflict(id, 'overwrite', false, 'gdrive:/forged~same'),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    await engine.resolveConflict(
      id,
      'overwrite',
      false,
      googleChildPath(googleRootPath, 'same', second.id),
    );
    await wait(id);
    expect(first.content.toString()).toBe('first');
    expect(second.content.toString()).toBe('new');
  });
  it('cancels and resumes a current-run upload using a checked source and server offset', async () => {
    const content = Buffer.alloc(4 * 1048576 + 11, 0x4a);
    await writeFile(join(root, 'resume'), content);
    let id = '';
    harness.fixture.afterChunk = () => {
      harness.fixture.afterChunk = undefined;
      engine.cancel(id);
    };
    id = upload('resume');
    await wait(id, 'cancelled');
    await engine.retry(id, true);
    await wait(id);
    expect(engine.snapshots()[0]?.transferredBytes).toBe(BigInt(content.length));
    const actual = await google.stat(path(googleChildPath(googleRootPath, 'resume')));
    expect(actual.size).toBe(BigInt(content.length));
    const query = harness.fixture.requests.find(
      (request) => request.headers['content-range'] === `bytes */${content.length}`,
    );
    expect(query).toBeDefined();
    expect(harness.fixture.sessions.size).toBe(1);
  });
  it('refuses resume after source changes and can restart an expired session without duplicating creates', async () => {
    await writeFile(join(root, 'change'), Buffer.alloc(3 * 1048576));
    let id = '';
    harness.fixture.afterChunk = () => {
      harness.fixture.afterChunk = undefined;
      engine.cancel(id);
    };
    id = upload('change');
    await wait(id, 'cancelled');
    await writeFile(join(root, 'change'), 'changed');
    await engine.retry(id, true);
    await wait(id, 'failed');
    expect(engine.snapshots()[0]?.errorKey).toBe('errors.transfer.unsafeResume');
    harness.fixture.expireSessions = true;
    await engine.retry(id, false);
    await wait(id, 'failed');
    harness.fixture.expireSessions = false;
    await engine.retry(id, false);
    await wait(id);
    expect(
      (await google.list(path(googleRootPath))).filter((item) => item.name === 'change'),
    ).toHaveLength(1);
  });
  it('detects a changing source before publishing the final chunk', async () => {
    await writeFile(join(root, 'changing'), Buffer.alloc(3 * 1048576));
    harness.fixture.afterChunk = () => {
      harness.fixture.afterChunk = undefined;
      const entry = required(harness.fixture.accounts.get('one'));
      entry.set('trigger', googleFixtureEntry('trigger', ''));
    };
    const originalStat = local.stat.bind(local);
    let reads = 0;
    local.stat = async (...args) => {
      const entry = await originalStat(...args);
      reads += 1;
      return reads > 2 ? { ...entry, modifiedAt: 'changed' } : entry;
    };
    const id = upload('changing');
    await wait(id, 'failed');
    expect(engine.snapshots()[0]?.errorKey).toBe('errors.transfer.unsafeResume');
    expect((await google.list(path(googleRootPath))).some((item) => item.name === 'changing')).toBe(
      false,
    );
  });
  it('exports native documents with an explicit format and never overwrites their native IDs', async () => {
    const doc = googleFixtureEntry('Report', 'native');
    doc.mimeType = 'application/vnd.google-apps.document';
    required(harness.fixture.accounts.get('one')).set(doc.id, doc);
    const address = googleExportPath(
      googleChildPath(googleRootPath, doc.name, doc.id),
      'application/pdf',
    );
    const id = engine.enqueue({
      source: google,
      sourcePath: path(address),
      destination: local,
      destinationPath: localPath(join(root, 'Report.pdf')),
      workspaceId: 'source',
      direction: 'download',
      conflictPolicy: 'ask',
    });
    await wait(id);
    expect(await readFile(join(root, 'Report.pdf'), 'utf8')).toBe(
      `export:${doc.id}:application/pdf`,
    );
  });
  it('persists secret-free profiles, ID listings and independent sessions, and signs out', async () => {
    const service = new WorkspaceService(
      harness.store,
      harness.credentials,
      async () => [],
      async () => null,
      undefined,
      undefined,
      { google: harness.configuration },
    );
    try {
      await service.execute({
        action: 'connect',
        workspaceId: 'left',
        profileId: harness.profile.id,
      });
      const listing = (await service.execute({ action: 'list', workspaceId: 'left', path: null }))
        .listing;
      expect(listing?.currentPath).toBe(googleRootPath);
      expect(listing?.displayPath).toBe('/My Drive');
      expect(service.snapshot().googleOAuthConfigured).toBe(true);
      expect(
        (await service.execute({ action: 'test-profile', profileId: harness.profile.id }))
          .connectionTest?.status,
      ).toBe('success');
      const archive = exportProfiles(harness.store);
      expect(archive).not.toMatch(
        /fixture-access|fixture-refresh|accountId|accountName|authentication/u,
      );
      expect(importProfiles(harness.store, archive)).toBe(1);
      const clone = await service.execute({
        action: 'clone-profile',
        profileId: harness.profile.id,
        name: 'Copy',
      });
      expect(
        service
          .snapshot()
          .googleAuthorizations?.find((item) => item.profileId === clone.savedProfileId)
          ?.authorized,
      ).toBe(false);
      expect(
        workspaceRequestSchema.safeParse({
          action: 'authorize-google-profile',
          profileId: harness.profile.id,
          token: 'injected',
        }).success,
      ).toBe(false);
      await service.execute({
        action: 'forget-google-authorization',
        profileId: harness.profile.id,
      });
      await expect(
        service.execute({ action: 'connect', workspaceId: 'left', profileId: harness.profile.id }),
      ).rejects.toMatchObject({ code: 'OAUTH_REQUIRED' });
      expect(service.snapshot().sessions[0]?.authorizationRequired).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
