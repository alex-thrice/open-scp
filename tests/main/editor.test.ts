// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { openEditor } from '../../src/main/external/editor';

describe('external editor launcher', () => {
  it.each([
    ['win32', 'notepad.exe', ['C:\\Folder with spaces\\notes.txt']],
    ['darwin', '/usr/bin/open', ['-a', 'TextEdit', '/tmp/notes file.txt']],
    ['linux', 'gedit', ['/tmp/notes file.txt']],
  ] as const)('uses a safe platform default on %s', async (platform, executable, arguments_) => {
    const startProcess = vi.fn(async () => undefined);
    const filePath = platform === 'win32' ? arguments_[0] : (arguments_.at(-1) ?? '');

    await openEditor(filePath, null, { platform, startProcess });

    expect(startProcess).toHaveBeenCalledWith(executable, arguments_);
  });

  it('passes the file as one argument to a configured executable', async () => {
    const startProcess = vi.fn(async () => undefined);
    await openEditor('C:\\Files\\a & b.txt', 'C:\\Tools\\Editor App\\editor.exe', {
      platform: 'win32',
      startProcess,
    });
    expect(startProcess).toHaveBeenCalledWith('C:\\Tools\\Editor App\\editor.exe', [
      'C:\\Files\\a & b.txt',
    ]);
  });

  it('rejects a relative configured executable and maps missing defaults', async () => {
    await expect(
      openEditor('/tmp/file.txt', 'editor', {
        platform: 'linux',
        startProcess: vi.fn(async () => undefined),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_PATH' });
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    await expect(
      openEditor('/tmp/file.txt', null, {
        platform: 'linux',
        startProcess: vi.fn(async () => Promise.reject(missing)),
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_APPLICATION_UNAVAILABLE' });
  });
});
