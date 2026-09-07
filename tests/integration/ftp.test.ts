import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFtpProviderPath } from '../../src/shared/models/provider-path';
import { runFileSystemProviderContractTests } from '../providers/provider-contract';
import { createFtpFixtureProvider } from './ftp-harness';

describe('FTP connection and compatibility', () => {
  it('uses password authentication and never presents plain FTP as encrypted', async () => {
    const good = createFtpFixtureProvider();
    const bad = createFtpFixtureProvider('wrong-fixture-password');
    try {
      await good.provider.connect();
      expect(good.provider.connectionState).toBe('connected');
      expect(good.provider.capabilities).toMatchObject({
        atomicRename: false,
        permissions: false,
        resumeRead: false,
        resumeWrite: false,
        symbolicLinks: false,
      });
      await expect(bad.provider.connect()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    } finally {
      await good.provider.disconnect();
      await bad.provider.disconnect();
    }
  });

  it('lists UTF-8 names and exposes only reliable LIST/MLSD metadata', async () => {
    const fixture = createFtpFixtureProvider();
    try {
      await fixture.provider.connect();
      const entries = await fixture.provider.list(createFtpProviderPath('/data'));
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'directory', name: 'Unicode каталог' }),
          expect.objectContaining({ kind: 'file', name: 'file with spaces.txt' }),
        ]),
      );
      expect(entries.every((entry) => entry.permissions === undefined)).toBe(true);
    } finally {
      await fixture.provider.disconnect();
    }
  });
});

runFileSystemProviderContractTests('FTP', async () => {
  const fixture = createFtpFixtureProvider();
  await fixture.provider.connect();
  const root = `/data/contract-${randomUUID()}`;
  await fixture.provider.createDirectory(createFtpProviderPath(root));
  await fixture.provider.disconnect();
  return {
    provider: fixture.provider,
    root: createFtpProviderPath(root),
    path: (...segments) => createFtpProviderPath([root, ...segments].join('/')),
    dispose: async () => {
      await fixture.provider.connect();
      await fixture.provider.delete(createFtpProviderPath(root), { recursive: true });
      await fixture.provider.disconnect();
    },
  };
});
