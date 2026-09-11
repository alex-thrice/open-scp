// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';
import { resolveAutoUpdater, UpdateService } from '../../src/main/updates/update-service';
import { defaultUpdateSettings } from '../../src/shared/models/application-update';

const updaterFixture = () => {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  return updater;
};

describe('update service', () => {
  it('resolves the CommonJS default export used in packaged builds', () => {
    const updater = updaterFixture();

    expect(resolveAutoUpdater({ default: { autoUpdater: updater } })).toBe(updater);
    expect(resolveAutoUpdater({ autoUpdater: updater })).toBe(updater);
  });

  it('checks, downloads an available version and installs it on request', async () => {
    const updater = updaterFixture();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.4.0' });
      return null;
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42 });
      updater.emit('update-downloaded', { version: '0.4.0' });
      return [];
    });
    const service = new UpdateService(updater as unknown as AppUpdater, '0.3.0', true, {
      ...defaultUpdateSettings,
      automaticDownload: true,
      automaticInstall: true,
    });

    await service.check();
    expect(service.snapshot().status).toBe('downloaded');
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('checks without downloading or installing by default', async () => {
    const updater = updaterFixture();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.4.0' });
      return null;
    });
    const service = new UpdateService(
      updater as unknown as AppUpdater,
      '0.3.0',
      true,
      defaultUpdateSettings,
    );

    await service.check();
    expect(service.snapshot().status).toBe('available');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('checks for updates but opens the release page when automatic updates are unavailable', async () => {
    const updater = updaterFixture();
    const openRelease = vi.fn(async () => undefined);
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.4.0' });
      return null;
    });
    const service = new UpdateService(
      updater as unknown as AppUpdater,
      '0.3.0',
      true,
      {
        ...defaultUpdateSettings,
        automaticDownload: true,
        automaticInstall: true,
      },
      { automaticUpdateSupported: false, openRelease },
    );

    await service.check();
    expect(service.snapshot()).toMatchObject({
      automaticUpdateSupported: false,
      availableVersion: '0.4.0',
      status: 'available',
    });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    await service.download();
    expect(openRelease).toHaveBeenCalledWith('0.4.0');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('does not contact the update server from an unpackaged build', async () => {
    const updater = updaterFixture();
    const service = new UpdateService(
      updater as unknown as AppUpdater,
      '0.3.0',
      false,
      defaultUpdateSettings,
    );

    await service.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({ status: 'error', errorKey: 'updates.unsupported' });
  });

  it('remains unavailable when no platform updater can be loaded', async () => {
    const service = new UpdateService(undefined, '0.3.0', true, defaultUpdateSettings);

    await service.check();
    expect(service.snapshot()).toMatchObject({
      supported: false,
      status: 'error',
      errorKey: 'updates.unsupported',
    });
  });

  it('distinguishes missing release metadata from a connection failure', async () => {
    const updater = updaterFixture();
    updater.checkForUpdates.mockRejectedValue(
      Object.assign(new Error('latest.yml was not found'), { statusCode: 404 }),
    );
    const service = new UpdateService(
      updater as unknown as AppUpdater,
      '0.3.0',
      true,
      defaultUpdateSettings,
    );

    await service.check();
    expect(service.snapshot()).toMatchObject({
      status: 'error',
      errorKey: 'updates.metadataUnavailable',
    });
  });
});
