// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ICloudConnection } from '../../src/main/providers/icloud/icloud-connection';
import { ICloudProvider } from '../../src/main/providers/icloud/icloud-provider';
import { serializeApplicationError } from '../../src/main/ipc/application-error';
import { createRemoteProviderPath, type ProviderPath } from '../../src/shared/models/provider-path';
import { startICloudFixture } from '../fixtures/icloud-harness';

const path = (value: string) => createRemoteProviderPath('icloud', value);
describe('iCloud rclone process integration', () => {
  let fixture: Awaited<ReturnType<typeof startICloudFixture>>;
  let provider: ICloudProvider;
  beforeEach(async () => {
    fixture = await startICloudFixture();
    provider = fixture.create();
  });
  afterEach(async () => {
    await provider.disconnect();
    await fixture.close();
  });

  it('reports a missing executable and rejects other remote types', async () => {
    const missing = new ICloudProvider(
      new ICloudConnection(
        {
          id: randomUUID(),
          name: 'Missing executable',
          kind: 'icloud',
          remote: 'icloud',
        },
        (args) =>
          spawn('openscp-rclone-does-not-exist', [...args], { stdio: 'pipe', windowsHide: true }),
      ),
    );
    await expect(missing.connect()).rejects.toMatchObject({ code: 'RCLONE_UNAVAILABLE' });
    await missing.disconnect();
    await fixture.behavior({ remoteType: 'local' });
    await expect(provider.connect()).rejects.toMatchObject({ code: 'RCLONE_CONFIGURATION' });
  });

  it('normalizes expired login without exposing subprocess output', async () => {
    await fixture.behavior({
      command: 'lsjson',
      exit: 1,
      stderr: 'trust token expired password-cookie-canary',
    });
    const error = await provider.connect().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'RCLONE_AUTHENTICATION' });
    expect(String(error)).not.toContain('password-cookie-canary');
    expect(serializeApplicationError(error)).toEqual({
      code: 'RCLONE_AUTHENTICATION',
      messageKey: 'errors.icloud.authentication',
    });
    expect(provider.connection.failureCode).toBe('RCLONE_AUTHENTICATION');
  });

  it('reconnects while an older startup is being cancelled', async () => {
    await fixture.behavior({ command: 'listremotes', delay: 3000 });
    const previous = provider.connect().catch((error: unknown) => error);
    await provider.disconnect();
    await fixture.behavior({});
    await provider.connect();
    expect(await previous).toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(provider.connectionState).toBe('connected');
    expect(await provider.list(path('/'))).toEqual([]);
  });

  it('cancels startup, times out metadata and leaves independent sessions connected', async () => {
    const other = fixture.create('second');
    await provider.connect();
    await other.connect();
    await fixture.behavior({ command: 'lsjson', delay: 3000 });
    const reading = provider.list(path('/'));
    await provider.disconnect();
    await expect(reading).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(other.connectionState).toBe('connected');
    await expect(other.list(path('/'))).rejects.toMatchObject({ code: 'RCLONE_TIMEOUT' });
    await other.disconnect();
    await expect(provider.connect({ signal: AbortSignal.timeout(10) })).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(fixture.children.size).toBe(0);
  });

  it('validates paths, metadata and stream length instead of accepting partial data', async () => {
    await provider.connect();
    for (const invalid of ['/../outside', '/nested/../file', '/a\\b', '/a\n', '/a//b'])
      await expect(provider.stat(path(invalid))).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_PATH',
      });
    await expect(
      provider.stat({ provider: 'local', path: '/' } as ProviderPath),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_PATH' });
    await writeFile(join(fixture.root, 'icloud', 'file.txt'), 'complete-content');
    await fixture.behavior({ command: 'cat', truncate: true });
    const stream = await provider.openRead(path('/file.txt'));
    await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({
      code: 'PROVIDER_IO_ERROR',
    });
    await fixture.behavior({ invalidJson: true });
    await expect(provider.list(path('/'))).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
  });

  it('stages writes, protects existing files on cancellation and checks destination versions', async () => {
    await provider.connect();
    const target = join(fixture.root, 'icloud', 'existing.txt');
    await writeFile(target, 'original');
    const aborted = (
      await provider.openWrite(path('/existing.txt'), { overwrite: true })
    ).getWriter();
    await aborted.write(Buffer.from('replacement'));
    await aborted.abort();
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(join(fixture.root, 'icloud'))).toEqual(['existing.txt']);
    const writer = (
      await provider.openWrite(path('/existing.txt'), { overwrite: true, expectedSize: 3n })
    ).getWriter();
    await writer.write(Buffer.from('new'));
    await writeFile(target, 'changed independently');
    await expect(writer.close()).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect(await readFile(target, 'utf8')).toBe('changed independently');
    expect(await readdir(join(fixture.root, 'icloud'))).toEqual(['existing.txt']);
    const short = (
      await provider.openWrite(path('/short.txt'), { overwrite: false, expectedSize: 5n })
    ).getWriter();
    await short.write(Buffer.from('one'));
    await expect(short.close()).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    expect(await readdir(join(fixture.root, 'icloud'))).toEqual(['existing.txt']);
  });
});
