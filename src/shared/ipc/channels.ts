export const ipcRequestChannels = {
  workspace: 'workspace:request',
  getRuntimeInfo: 'app:get-runtime-info',
  listLocalDirectory: 'local:list-directory',
  listLocalDrives: 'local:list-drives',
} as const;

export type IpcRequestChannel = (typeof ipcRequestChannels)[keyof typeof ipcRequestChannels];

export const ipcEventChannels = {
  appReady: 'app:ready',
  applicationMenuCommand: 'app:menu-command',
} as const;

export type IpcEventChannel = (typeof ipcEventChannels)[keyof typeof ipcEventChannels];
