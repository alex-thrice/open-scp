import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleHarness, required } from '../fixtures/google-harness';
import { googleFixtureEntry } from '../fixtures/google-fixture';
import { createYandexHarness } from '../fixtures/yandex-harness';
import { startWebDavFixture, fixtureMailruPassword } from '../fixtures/webdav-fixture';
import { MailruProvider } from '../../src/main/providers/mailru/mailru-provider';
import { MailruConnection } from '../../src/main/providers/mailru/mailru-connection';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createGoogleProviderPath,
  createYandexProviderPath,
  createMailruProviderPath,
  createSftpProviderPath,
  createFtpProviderPath,
  createS3ProviderPath,
  type ProviderPath,
} from '../../src/shared/models/provider-path';
import type { FileSystemProvider } from '../../src/shared/providers/file-system-provider';
import { googleChildPath, googleRootPath } from '../../src/shared/models/google-path';
import { createFixtureProvider, trustFixture } from './sftp-harness';
import { createFtpFixtureProvider } from './ftp-harness';
import { createMinioProvider } from './s3-harness';

describe('Google cross-provider transfers', () => {
  it.each(['mailru', 'yandex', 'sftp', 'ftp', 's3'] as const)(
    'round-trips Google ↔ %s through the common queue',
    async (kind) => {
      const harness = await createGoogleHarness();
      await harness.authorize();
      const google = harness.provider();
      const engine = new TransferEngine();
      const name = `google-${randomUUID()}.bin`;
      const content = Buffer.alloc(2 * 1048576 + 13, 0x37);
      const original = googleFixtureEntry('original', content);
      required(harness.fixture.accounts.get('one')).set(original.id, original);
      let remote: FileSystemProvider;
      let target: ProviderPath;
      let close = () => Promise.resolve();
      if (kind === 'yandex') {
        const fixture = await createYandexHarness();
        await fixture.authorize();
        remote = fixture.provider();
        target = createYandexProviderPath('/' + name);
        close = fixture.close;
      } else if (kind === 'mailru') {
        const fixture = await startWebDavFixture();
        close = fixture.close;
        remote = new MailruProvider(
          new MailruConnection(
            {
              id: randomUUID(),
              name: 'fixture',
              kind: 'mailru',
              username: 'fixture@example.test',
              timeout: 5000,
              authentication: {
                method: 'password',
                secret: { id: randomUUID(), storage: 'safe-storage' },
              },
            },
            async () => ({ password: fixtureMailruPassword }),
            fixture.endpoint,
          ),
        );
        target = createMailruProviderPath('/' + name);
      } else if (kind === 'sftp') {
        const fixture = createFixtureProvider();
        await trustFixture(fixture);
        remote = fixture.provider;
        target = createSftpProviderPath('/home/fixture/data/' + name);
      } else if (kind === 'ftp') {
        remote = createFtpFixtureProvider().provider;
        target = createFtpProviderPath('/data/' + name);
      } else {
        remote = createMinioProvider();
        target = createS3ProviderPath('fixture-bucket', name);
      }
      const copy = async (
        source: FileSystemProvider,
        sourcePath: ProviderPath,
        destination: FileSystemProvider,
        destinationPath: ProviderPath,
      ) => {
        const id = engine.enqueue({
          source,
          sourcePath,
          destination,
          destinationPath,
          workspaceId: 'source',
          destinationWorkspaceId: 'destination',
          direction: 'remote',
          conflictPolicy: 'ask',
        });
        await vi.waitFor(
          () => {
            const snapshot = engine.snapshots().find((item) => item.id === id);
            expect(snapshot?.state, snapshot?.errorKey ?? '').toBe('completed');
          },
          { timeout: 30000, interval: 20 },
        );
      };
      try {
        await google.connect();
        await remote.connect();
        await copy(
          google,
          createGoogleProviderPath(googleChildPath(googleRootPath, 'original', original.id)),
          remote,
          target,
        );
        await copy(
          remote,
          target,
          google,
          createGoogleProviderPath(googleChildPath(googleRootPath, 'returned')),
        );
        const result = (await google.list(createGoogleProviderPath(googleRootPath))).find(
          (entry) => entry.name === 'returned',
        );
        expect(result).toBeDefined();
        const returned = required(harness.fixture.accounts.get('one')).get(
          required(result?.google?.id),
        );
        expect(returned?.content.equals(content)).toBe(true);
      } finally {
        engine.dispose();
        await remote.delete(target, { recursive: false }).catch(() => undefined);
        await remote.disconnect();
        await google.disconnect();
        await close();
        await harness.close();
      }
    },
  );
});
