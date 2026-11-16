import type {
  AppReadyEvent,
  ApplicationMenuCommandEvent,
  IpcEventEnvelope,
  IpcResponseEnvelope,
  LocalDirectoryListing,
  LocalDirectoryWatchRequest,
  LocalDirectoryChangedEvent,
  LocalDrive,
  RuntimeInfo,
} from '@shared/ipc/contracts';
import type { WorkspaceRequest, WorkspaceResult } from '@shared/ipc/workspace';
import type { FileDragRequest } from '@shared/ipc/file-drag';

export interface DesktopApi {
  readonly startFileDrag?: (request: FileDragRequest) => Promise<IpcResponseEnvelope<null>>;
  readonly getPathForFile?: (file: File) => string;
  readonly workspace: (request: WorkspaceRequest) => Promise<IpcResponseEnvelope<WorkspaceResult>>;
  readonly getRuntimeInfo: () => Promise<IpcResponseEnvelope<RuntimeInfo>>;
  readonly listLocalDirectory: (
    path: string | null,
  ) => Promise<IpcResponseEnvelope<LocalDirectoryListing>>;
  readonly listLocalDrives: () => Promise<IpcResponseEnvelope<readonly LocalDrive[]>>;
  readonly setLocalDirectoryWatch: (
    request: LocalDirectoryWatchRequest,
  ) => Promise<IpcResponseEnvelope<null>>;
  readonly onLocalDirectoryChanged: (
    listener: (event: IpcEventEnvelope<LocalDirectoryChangedEvent>) => void,
  ) => () => void;
  readonly onAppReady: (listener: (event: IpcEventEnvelope<AppReadyEvent>) => void) => () => void;
  readonly onApplicationMenuCommand: (
    listener: (event: IpcEventEnvelope<ApplicationMenuCommandEvent>) => void,
  ) => () => void;
  readonly runtime: 'electron';
}
