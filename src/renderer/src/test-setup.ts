import type { DesktopApi } from '@shared/desktop-api';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import './i18n';

afterEach(cleanup);

const desktopApi: DesktopApi = Object.freeze({
  workspace: async () => ({
    correlationId: '00000000-0000-4000-8000-000000000001',
    ok: true as const,
    data: {
      snapshot: { profiles: [], sessions: [], transfers: [], language: null },
      listing: null,
      privateKeyPath: null,
    },
  }),
  getRuntimeInfo: async () => ({
    correlationId: '00000000-0000-4000-8000-000000000001',
    data: {
      platform: 'win32',
      runtime: 'electron',
    } as const,
    ok: true as const,
  }),
  listLocalDirectory: async () => ({
    correlationId: '00000000-0000-4000-8000-000000000001',
    data: {
      breadcrumbs: [{ label: 'Home', path: 'C:\\Users\\test' }],
      currentPath: 'C:\\Users\\test',
      entries: [],
      parentPath: null,
    },
    ok: true as const,
  }),
  listLocalDrives: async () => ({
    correlationId: '00000000-0000-4000-8000-000000000001',
    data: [{ label: 'C:\\', path: 'C:\\' }],
    ok: true as const,
  }),
  onAppReady: () => () => undefined,
  onApplicationMenuCommand: () => () => undefined,
  runtime: 'electron',
});

if (typeof window !== 'undefined')
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: desktopApi,
  });
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}
