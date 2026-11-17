import { realpathSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';

interface WatchedDirectory {
  readonly key: string;
  readonly path: string;
  readonly listeners: Set<() => void>;
  watcher: FSWatcher | undefined;
  notificationTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  shouldReattach: boolean;
}

const notificationDelay = 150;
const retryDelay = 1000;

export class LocalDirectoryWatchService {
  private readonly directories = new Map<string, WatchedDirectory>();
  private disposed = false;

  public subscribe(path: string, listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    const resolvedPath = resolve(path);
    const key = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    let directory = this.directories.get(key);
    const subscription = () => listener();
    if (!directory) {
      directory = {
        key,
        path: resolvedPath,
        listeners: new Set(),
        watcher: undefined,
        notificationTimer: undefined,
        retryTimer: undefined,
        shouldReattach: false,
      };
      this.directories.set(key, directory);
    }
    const subscribedDirectory = directory;
    subscribedDirectory.listeners.add(subscription);
    if (!subscribedDirectory.watcher && !subscribedDirectory.retryTimer) {
      if (!this.startWatching(subscribedDirectory)) this.scheduleNotification(subscribedDirectory);
    }
    return () => {
      subscribedDirectory.listeners.delete(subscription);
      if (subscribedDirectory.listeners.size === 0) this.release(subscribedDirectory);
    };
  }

  public dispose(): void {
    this.disposed = true;
    for (const directory of this.directories.values()) this.release(directory);
  }

  private isActive(directory: WatchedDirectory): boolean {
    return this.directories.get(directory.key) === directory && directory.listeners.size > 0;
  }

  private startWatching(directory: WatchedDirectory): boolean {
    if (!this.isActive(directory)) return false;
    if (directory.watcher) return true;
    try {
      // Раскрываем короткие имена Windows, чтобы libuv сравнивал пути в одинаковом формате.
      const watchPath =
        process.platform === 'win32' ? realpathSync.native(directory.path) : directory.path;
      const watcher = watch(watchPath, { persistent: false }, (eventType) => {
        if (directory.watcher !== watcher) return;
        if (eventType === 'rename') directory.shouldReattach = true;
        this.scheduleNotification(directory);
      });
      directory.watcher = watcher;
      if (directory.retryTimer) clearTimeout(directory.retryTimer);
      directory.retryTimer = undefined;
      const onFailure = () => {
        if (directory.watcher !== watcher) return;
        this.closeWatcher(directory);
        this.scheduleNotification(directory);
        this.scheduleRetry(directory);
      };
      watcher.on('error', onFailure);
      watcher.on('close', onFailure);
      return true;
    } catch {
      this.scheduleRetry(directory);
      return false;
    }
  }

  private scheduleNotification(directory: WatchedDirectory): void {
    if (!this.isActive(directory) || directory.notificationTimer) return;
    directory.notificationTimer = setTimeout(() => {
      directory.notificationTimer = undefined;
      if (!this.isActive(directory)) return;
      if (directory.shouldReattach) {
        directory.shouldReattach = false;
        // Путь после удаления и создания каталога может указывать на другой inode.
        this.closeWatcher(directory);
        this.startWatching(directory);
      }
      for (const listener of directory.listeners) listener();
    }, notificationDelay);
    directory.notificationTimer.unref();
  }

  private scheduleRetry(directory: WatchedDirectory): void {
    if (!this.isActive(directory) || directory.retryTimer) return;
    directory.retryTimer = setTimeout(() => {
      directory.retryTimer = undefined;
      if (this.startWatching(directory)) this.scheduleNotification(directory);
    }, retryDelay);
    directory.retryTimer.unref();
  }

  private closeWatcher(directory: WatchedDirectory): void {
    const watcher = directory.watcher;
    directory.watcher = undefined;
    watcher?.close();
  }

  private release(directory: WatchedDirectory): void {
    if (this.directories.get(directory.key) !== directory) return;
    this.directories.delete(directory.key);
    if (directory.notificationTimer) clearTimeout(directory.notificationTimer);
    if (directory.retryTimer) clearTimeout(directory.retryTimer);
    directory.listeners.clear();
    this.closeWatcher(directory);
  }
}
