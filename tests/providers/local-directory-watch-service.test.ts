// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync, watch, type FSWatcher, type WatchListener } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDirectoryWatchService } from '../../src/main/providers/local/local-directory-watch-service';

vi.mock('node:fs', { spy: true });

const services: LocalDirectoryWatchService[] = [];
const temporaryDirectories: string[] = [];

const createService = (): LocalDirectoryWatchService => {
  const service = new LocalDirectoryWatchService();
  services.push(service);
  return service;
};

const mockWatchers = () => {
  vi.spyOn(realpathSync, 'native').mockImplementation((path) => String(path));
  const callbacks: WatchListener<string>[] = [];
  const watchers: ReturnType<typeof createWatcher>[] = [];
  const createWatcher = () =>
    Object.assign(new EventEmitter(), {
      close: vi.fn(),
    });
  vi.mocked(watch).mockImplementation((...arguments_) => {
    const callback = arguments_.at(-1);
    if (typeof callback !== 'function') throw new Error('Missing watch listener.');
    callbacks.push(callback);
    const watcher = createWatcher();
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  });
  return { callbacks, watchers };
};

beforeEach(async () => {
  const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(watch).mockReset().mockImplementation(originalFs.watch);
  vi.spyOn(realpathSync, 'native').mockReset().mockImplementation(originalFs.realpathSync.native);
});

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  for (const path of temporaryDirectories.splice(0))
    await rm(path, { force: true, recursive: true });
});

describe('LocalDirectoryWatchService', () => {
  it('shares normalized directories and releases the watcher only after the last subscription', () => {
    const { watchers } = mockWatchers();
    const service = createService();
    const callback = vi.fn();
    const first = service.subscribe(resolve('fixture', '.'), callback);
    const second = service.subscribe(
      process.platform === 'win32' ? resolve('fixture').toUpperCase() : resolve('fixture'),
      callback,
    );

    expect(watch).toHaveBeenCalledOnce();
    first();
    first();
    expect(watchers[0]?.close).not.toHaveBeenCalled();
    second();
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    service.dispose();
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
  });

  it('coalesces bursts without postponing updates during continuous writes', () => {
    vi.useFakeTimers();
    const { callbacks } = mockWatchers();
    const service = createService();
    const first = vi.fn();
    const second = vi.fn();
    service.subscribe('fixture', first);
    service.subscribe('fixture', second);

    for (let index = 0; index < 3; index++) {
      callbacks[0]?.('change', null);
      vi.advanceTimersByTime(50);
    }
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    callbacks[0]?.('change', 'file.txt');
    vi.advanceTimersByTime(150);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('reattaches after renames before invalidating the listing and ignores obsolete watchers', () => {
    vi.useFakeTimers();
    const { callbacks, watchers } = mockWatchers();
    const service = createService();
    const listener = vi.fn(() => expect(watch).toHaveBeenCalledTimes(2));
    service.subscribe('fixture', listener);

    callbacks[0]?.('rename', 'file.txt');
    callbacks[0]?.('rename', 'other.txt');
    vi.advanceTimersByTime(150);
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();

    callbacks[0]?.('change', null);
    watchers[0]?.emit('close');
    vi.advanceTimersByTime(1000);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('invalidates on watcher errors, retries and cancels pending work on unsubscribe', () => {
    vi.useFakeTimers();
    const { watchers } = mockWatchers();
    const service = createService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe('fixture', listener);

    watchers[0]?.emit('error', new Error('Unavailable directory.'));
    vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledOnce();
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(850);
    expect(watch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledTimes(2);

    watchers[1]?.emit('close');
    unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers when the directory is initially unavailable', () => {
    vi.useFakeTimers();
    mockWatchers();
    vi.mocked(watch).mockImplementationOnce(() => {
      throw new Error('Directory missing.');
    });
    const service = createService();
    const listener = vi.fn();
    service.subscribe('fixture', listener);

    vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);

    service.dispose();
    service.subscribe('another-fixture', listener);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')(
    'canonicalizes Windows native watch paths again when recovering a logical short path',
    () => {
      vi.useFakeTimers();
      const { watchers } = mockWatchers();
      const aliasPath = resolve('SHORT~1', 'WATCH~1');
      const canonicalPath = resolve('Long directory name', 'Watched directory');
      const recreatedPath = resolve('Long directory name', 'Recreated watched directory');
      const nativeRealpath = vi
        .mocked(realpathSync.native)
        .mockReturnValueOnce(canonicalPath)
        .mockImplementationOnce(() => {
          throw new Error('Directory temporarily unavailable.');
        })
        .mockReturnValueOnce(recreatedPath);
      const service = createService();
      const listener = vi.fn();
      service.subscribe(aliasPath, listener);

      expect(watch).toHaveBeenNthCalledWith(
        1,
        canonicalPath,
        { persistent: false },
        expect.any(Function),
      );
      watchers[0]?.emit('error', new Error('Directory removed.'));
      vi.advanceTimersByTime(1000);
      expect(watch).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1150);
      expect(watch).toHaveBeenNthCalledWith(
        2,
        recreatedPath,
        { persistent: false },
        expect.any(Function),
      );
      expect(nativeRealpath).toHaveBeenCalledTimes(3);
      for (const call of nativeRealpath.mock.calls) expect(call).toEqual([aliasPath]);
      expect(listener).toHaveBeenCalledTimes(2);
    },
  );

  it('observes external file creation, modification, rename and deletion', async () => {
    const path = await mkdtemp(join(tmpdir(), 'openscp-watch-'));
    temporaryDirectories.push(path);
    const service = createService();
    const listener = vi.fn();
    service.subscribe(path, listener);
    const filePath = join(path, 'file.txt');
    const renamedPath = join(path, 'renamed.txt');
    const expectChange = async (operation: () => Promise<unknown>) => {
      listener.mockClear();
      await operation();
      await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 3000 });
    };

    await expectChange(() => writeFile(filePath, 'created'));
    await expectChange(() => writeFile(filePath, 'modified content'));
    await expectChange(() => rename(filePath, renamedPath));
    await expectChange(() => rm(renamedPath));
  });

  it('resumes observing a directory after it is removed and recreated', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'openscp-rewatch-'));
    temporaryDirectories.push(rootPath);
    const path = join(rootPath, 'directory');
    await mkdir(path);
    const service = createService();
    const listener = vi.fn();
    service.subscribe(path, listener);

    await rm(path, { recursive: true });
    await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 3000 });
    listener.mockClear();
    await mkdir(path);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 3000 });
    listener.mockClear();
    await writeFile(join(path, 'recreated.txt'), 'new inode');
    await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 3000 });
  });

  it.skipIf(process.platform !== 'win32')(
    'observes long-path operations through a Windows 8.3 directory alias and recovers after recreation',
    async (context) => {
      const rootPath = await mkdtemp(join(tmpdir(), 'openscp-short-path-regression-'));
      temporaryDirectories.push(rootPath);
      const directoryPath = join(rootPath, 'watched-directory');
      await mkdir(directoryPath);
      const canonicalPath = realpathSync.native(directoryPath);
      const shortPathResult = spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/c', 'for %I in ("%OPENSCP_WATCH_TEST_PATH%") do @echo %~sI'],
        {
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: { ...process.env, OPENSCP_WATCH_TEST_PATH: directoryPath },
        },
      );
      if (shortPathResult.error) throw shortPathResult.error;
      expect(shortPathResult.status).toBe(0);
      const aliasPath = shortPathResult.stdout.trim();
      expect(aliasPath).not.toBe('');
      if (aliasPath.toLowerCase() === canonicalPath.toLowerCase()) {
        context.skip('The fixture volume does not provide an 8.3 directory alias.');
        return;
      }
      expect(realpathSync.native(aliasPath).toLowerCase()).toBe(canonicalPath.toLowerCase());
      const service = createService();
      const listener = vi.fn();
      service.subscribe(aliasPath, listener);
      const filePath = join(canonicalPath, 'file.txt');
      const renamedPath = join(canonicalPath, 'renamed.txt');
      const expectChange = async (operation: () => Promise<unknown>) => {
        listener.mockClear();
        await operation();
        await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 3000 });
      };

      await expectChange(() => writeFile(filePath, 'created through the long path'));
      await expectChange(() => rename(filePath, renamedPath));
      await expectChange(() => rm(renamedPath));
      await expectChange(() => rm(canonicalPath, { recursive: true }));
      await expectChange(() => mkdir(canonicalPath));
      await expectChange(() => writeFile(join(canonicalPath, 'recreated.txt'), 'recreated'));
    },
  );
});
