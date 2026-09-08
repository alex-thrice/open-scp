// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';
import { UpdateService } from '../../src/main/updates/update-service';
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
    const service = new UpdateService(
      updater as unknown as AppUpdater,
      '0.3.0',
      true,
      defaultUpdateSettings,
    );

    await service.check();
    expect(service.snapshot().status).toBe('downloaded');
    expect(updater.autoDownload).toBe(false);
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
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
});
