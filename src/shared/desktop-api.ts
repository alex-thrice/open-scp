import type {
  AppReadyEvent,
  ApplicationMenuCommandEvent,
  IpcEventEnvelope,
  IpcResponseEnvelope,
  LocalDirectoryListing,
  LocalDrive,
  RuntimeInfo,
} from '@shared/ipc/contracts';
import type { WorkspaceRequest, WorkspaceResult } from '@shared/ipc/workspace';

export interface DesktopApi {
  readonly getPathForFile?: (file: File) => string;
  readonly workspace: (request: WorkspaceRequest) => Promise<IpcResponseEnvelope<WorkspaceResult>>;
  readonly getRuntimeInfo: () => Promise<IpcResponseEnvelope<RuntimeInfo>>;
  readonly listLocalDirectory: (
    path: string | null,
  ) => Promise<IpcResponseEnvelope<LocalDirectoryListing>>;
  readonly listLocalDrives: () => Promise<IpcResponseEnvelope<readonly LocalDrive[]>>;
  readonly onAppReady: (listener: (event: IpcEventEnvelope<AppReadyEvent>) => void) => () => void;
  readonly onApplicationMenuCommand: (
    listener: (event: IpcEventEnvelope<ApplicationMenuCommandEvent>) => void,
  ) => () => void;
  readonly runtime: 'electron';
}
