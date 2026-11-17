export const ipcRequestChannels = {
  startFileDrag: 'files:start-drag',
  workspace: 'workspace:request',
  getRuntimeInfo: 'app:get-runtime-info',
  listLocalDirectory: 'local:list-directory',
  setLocalDirectoryWatch: 'local:set-directory-watch',
  listLocalDrives: 'local:list-drives',
} as const;

export type IpcRequestChannel = (typeof ipcRequestChannels)[keyof typeof ipcRequestChannels];

export const ipcEventChannels = {
  appReady: 'app:ready',
  applicationMenuCommand: 'app:menu-command',
  localDirectoryChanged: 'local:directory-changed',
} as const;

export type IpcEventChannel = (typeof ipcEventChannels)[keyof typeof ipcEventChannels];
