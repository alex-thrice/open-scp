import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron';
import { join } from 'node:path';

export const createWebPreferences = (preloadDirectory: string): WebPreferences => ({
  allowRunningInsecureContent: false,
  contextIsolation: true,
  nodeIntegration: false,
  preload: join(preloadDirectory, '../preload/index.js'),
  safeDialogs: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
});

export const createWindowOptions = (preloadDirectory: string): BrowserWindowConstructorOptions => ({
  backgroundColor: '#f2f4f8',
  height: 720,
  minHeight: 560,
  minWidth: 880,
  show: false,
  webPreferences: createWebPreferences(preloadDirectory),
  width: 1120,
});
