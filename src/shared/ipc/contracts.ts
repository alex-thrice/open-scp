import type { SerializedApplicationError } from '@shared/errors/application-error';
import type { WorkspaceRequest, WorkspaceResult } from './workspace';
import { ipcEventChannels, ipcRequestChannels } from '@shared/ipc/channels';
import type { FileSystemEntryKind } from '@shared/models/file-system-entry';

export type RuntimePlatform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32';

export interface RuntimeInfo {
  readonly platform: RuntimePlatform;
  readonly runtime: 'electron';
}

export interface LocalDirectoryRequest {
  readonly path: string | null;
}

export interface LocalDrive {
  readonly icon?: string | undefined;
  readonly label: string;
  readonly path: string;
}

export interface LocalBreadcrumb {
  readonly label: string;
  readonly path: string;
}

export interface LocalDirectoryEntry {
  readonly s3Kind?: 'bucket' | 'prefix' | 'object' | undefined;
  readonly permissions?: number | null;
  readonly kind: FileSystemEntryKind;
  readonly modifiedAt: string | null;
  readonly name: string;
  readonly path: string;
  readonly size: bigint;
}

export interface LocalDirectoryListing {
  readonly breadcrumbs: readonly LocalBreadcrumb[];
  readonly currentPath: string;
  readonly entries: readonly LocalDirectoryEntry[];
  readonly parentPath: string | null;
}

export type EmptyIpcRequest = Readonly<Record<string, never>>;

export interface IpcRequestEnvelope<Payload> {
  readonly correlationId: string;
  readonly payload: Payload;
}

export interface IpcSuccessResponse<Data> {
  readonly correlationId: string;
  readonly data: Data;
  readonly ok: true;
}

export interface IpcFailureResponse {
  readonly correlationId: string;
  readonly error: SerializedApplicationError;
  readonly ok: false;
}

export type IpcResponseEnvelope<Data> = IpcSuccessResponse<Data> | IpcFailureResponse;

export interface IpcEventEnvelope<Payload> {
  readonly correlationId: string;
  readonly payload: Payload;
}

export interface AppReadyEvent {
  readonly occurredAt: string;
}

export interface IpcRequestMap {
  readonly [ipcRequestChannels.workspace]: WorkspaceRequest;
  readonly [ipcRequestChannels.getRuntimeInfo]: EmptyIpcRequest;
  readonly [ipcRequestChannels.listLocalDirectory]: LocalDirectoryRequest;
  readonly [ipcRequestChannels.listLocalDrives]: EmptyIpcRequest;
}

export interface IpcResponseMap {
  readonly [ipcRequestChannels.workspace]: WorkspaceResult;
  readonly [ipcRequestChannels.getRuntimeInfo]: RuntimeInfo;
  readonly [ipcRequestChannels.listLocalDirectory]: LocalDirectoryListing;
  readonly [ipcRequestChannels.listLocalDrives]: readonly LocalDrive[];
}

export interface IpcEventMap {
  readonly [ipcEventChannels.appReady]: AppReadyEvent;
}

export type IpcRequestFor<Channel extends keyof IpcRequestMap> = IpcRequestMap[Channel];

export type IpcResponseFor<Channel extends keyof IpcResponseMap> = IpcResponseMap[Channel];

export type IpcEventFor<Channel extends keyof IpcEventMap> = IpcEventMap[Channel];
