// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleConnection } from '../../src/main/providers/google/google-connection';
import { GoogleProvider } from '../../src/main/providers/google/google-provider';
import { discoverGoogleAvailability } from '../../src/main/providers/google/google-availability';
import { discoverICloudAvailability } from '../../src/main/providers/icloud/icloud-availability';
import { createGoogleProviderPath as path } from '../../src/shared/models/provider-path';
import { googleFixtureProfile, startGoogleFixture } from '../fixtures/google-fixture';

describe('Google Drive through configured rclone remotes', () => {
  let fixture: Awaited<ReturnType<typeof startGoogleFixture>>;
  let provider: GoogleProvider;
  beforeEach(async () => {
    fixture = await startGoogleFixture();
    provider = fixture.create();
  });
  afterEach(async () => {
    await provider.disconnect();
    await fixture.close();
  });

  it('discovers Google and iCloud separately and rejects a remote of the other type', async () => {
    expect(await discoverGoogleAvailability(fixture.launch)).toEqual({
      available: true,
      remotes: ['google', 'google-work'],
    });
    expect(await discoverICloudAvailability(fixture.launch)).toEqual({
      available: true,
      remotes: ['icloud', 'second'],
    });
    const wrong = fixture.create('icloud');
    await expect(wrong.connect()).rejects.toMatchObject({ code: 'RCLONE_CONFIGURATION' });
    await wrong.disconnect();
    const legacy = new GoogleProvider(
      new GoogleConnection(
        { id: googleFixtureProfile().id, name: 'Legacy Google', kind: 'google' },
        fixture.launch,
      ),
    );
    await expect(legacy.connect()).rejects.toMatchObject({ code: 'RCLONE_CONFIGURATION' });
    await legacy.disconnect();
  });

  it('keeps multiple Google accounts independent and normalizes startup failures', async () => {
    const other = fixture.create('google-work');
    await writeFile(join(fixture.root, 'google', 'personal.txt'), 'personal');
    await writeFile(join(fixture.root, 'google-work', 'work.txt'), 'work');
    await provider.connect();
    await other.connect();
    expect(await provider.list(path('/'))).toMatchObject([{ name: 'personal.txt' }]);
    expect(await other.list(path('/'))).toMatchObject([{ name: 'work.txt' }]);
    await provider.disconnect();
    expect(other.connectionState).toBe('connected');
    await other.disconnect();
    const missing = new GoogleProvider(
      new GoogleConnection(googleFixtureProfile(), (args) =>
        spawn('openscp-rclone-missing', [...args], { stdio: 'pipe', windowsHide: true }),
      ),
    );
    await expect(missing.connect()).rejects.toMatchObject({ code: 'RCLONE_UNAVAILABLE' });
    await missing.disconnect();
  });

  it('uses Google-safe flags and preserves ordinary file names and paths', async () => {
    await mkdir(join(fixture.root, 'google', 'Documents'));
    await writeFile(join(fixture.root, 'google', 'Documents', 'Test1.txt'), 'content');
    await provider.connect();
    expect(await provider.list(path('/Documents'))).toMatchObject([
      { name: 'Test1.txt', path: path('/Documents/Test1.txt'), kind: 'file' },
    ]);
    expect(fixture.commands.every((args) => args.includes('--drive-skip-gdocs'))).toBe(true);
    expect(fixture.commands.every((args) => args.includes('--drive-skip-shortcuts'))).toBe(true);
    expect(fixture.commands.every((args) => args.includes('--drive-use-trash=true'))).toBe(true);
    expect(fixture.commands.every((args) => args.includes('--drive-import-formats='))).toBe(true);
    for (const invalid of ['gdrive:/id~name', '/../outside', '/a\\b', '/a//b'])
      await expect(provider.stat(path(invalid))).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_PATH',
      });
  });

  it('preserves directory IDs from parent listings when stat roots are synthetic', async () => {
    await mkdir(join(fixture.root, 'google', 'Documents'));
    await provider.connect();
    expect(await provider.stat(path('/'))).toMatchObject({ kind: 'directory', name: '/' });
    expect((await provider.stat(path('/'))).resourceId).toBeUndefined();
    const directory = (await provider.list(path('/')))[0];
    expect(directory?.resourceId).toBeTruthy();
    expect(await provider.stat(path('/Documents'))).toMatchObject({
      name: 'Documents',
      resourceId: directory?.resourceId,
    });
    expect(
      fixture.commands.some((args) => args.includes('--stat') && args.includes('google:Documents')),
    ).toBe(false);
  });

  it('identifies the same resources through remotes with matching and nested roots', async () => {
    await mkdir(join(fixture.root, 'google', 'Documents', 'Nested'), { recursive: true });
    await writeFile(join(fixture.root, 'google', 'Documents', 'Nested', 'file.txt'), 'content');
    await fixture.behavior({ remoteRoots: { 'google-work': 'google' } });
    const alias = fixture.create('google-work');
    try {
      await provider.connect();
      await alias.connect();
      expect((await alias.stat(path('/Documents'))).resourceId).toBe(
        (await provider.stat(path('/Documents'))).resourceId,
      );
      await fixture.behavior({ remoteRoots: { 'google-work': 'google/Documents' } });
      expect((await alias.stat(path('/Nested/file.txt'))).resourceId).toBe(
        (await provider.stat(path('/Documents/Nested/file.txt'))).resourceId,
      );
    } finally {
      await alias.disconnect();
    }
  });

  it('reports expired Google authorization without exposing subprocess diagnostics', async () => {
    await fixture.behavior({
      command: 'lsjson',
      exit: 1,
      stderr: 'oauth2 invalid_grant token-canary',
    });
    const error: unknown = await provider.connect().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'RCLONE_AUTHENTICATION' });
    expect(String(error)).not.toContain('token-canary');
    expect(provider.connection.failureCode).toBe('RCLONE_AUTHENTICATION');
  });

  it('blocks duplicate names and ambiguous ancestor directories before reading or mutating', async () => {
    await mkdir(join(fixture.root, 'google', 'Duplicate'));
    await writeFile(join(fixture.root, 'google', 'Duplicate', 'file.txt'), 'original');
    await provider.connect();
    await fixture.behavior({ duplicateName: 'Duplicate' });
    await expect(provider.list(path('/'))).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    await expect(provider.openRead(path('/Duplicate/file.txt'))).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
    await expect(
      provider.delete(path('/Duplicate/file.txt'), { recursive: false }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
    await expect(
      provider.openWrite(path('/Duplicate/new.txt'), { overwrite: false }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
    expect(await readFile(join(fixture.root, 'google', 'Duplicate', 'file.txt'), 'utf8')).toBe(
      'original',
    );
    expect(
      fixture.commands.some((args) => ['cat', 'rcat', 'deletefile'].includes(args[0] ?? '')),
    ).toBe(false);
  });

  it('stages streamed writes, preserves the destination on cancellation and detects concurrent changes', async () => {
    await provider.connect();
    const target = join(fixture.root, 'google', 'file.txt');
    await writeFile(target, 'original');
    const aborted = (await provider.openWrite(path('/file.txt'), { overwrite: true })).getWriter();
    await aborted.write(Buffer.from('replacement'));
    await aborted.abort();
    expect(await readFile(target, 'utf8')).toBe('original');
    const writer = (
      await provider.openWrite(path('/file.txt'), { overwrite: true, expectedSize: 3n })
    ).getWriter();
    await writer.write(Buffer.from('new'));
    await writeFile(target, 'changed independently');
    await expect(writer.close()).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect(await readFile(target, 'utf8')).toBe('changed independently');
    expect(await readdir(join(fixture.root, 'google'))).toEqual(['file.txt']);
    expect(provider.capabilities).toMatchObject({
      resumeRead: false,
      resumeWrite: false,
      serverSideCopy: false,
    });
  });

  it('requires the staged object identity after publication instead of accepting a skipped move', async () => {
    await provider.connect();
    await fixture.behavior({ skipPublish: true });
    const writer = (
      await provider.openWrite(path('/published.txt'), { overwrite: false, expectedSize: 11n })
    ).getWriter();
    await writer.write(Buffer.from('replacement'));
    await expect(writer.close()).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect(await readFile(join(fixture.root, 'google', 'published.txt'), 'utf8')).toBe(
      'independent',
    );
  });
});
