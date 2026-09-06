import type {
  LocalDirectoryListing,
  LocalDirectoryRequest,
  LocalDrive,
  RuntimeInfo,
} from '@shared/ipc/contracts';
import { ipcRequestChannels } from '@shared/ipc/channels';
import { z } from 'zod';
import {
  workspaceRequestSchema,
  workspaceResultSchema,
  type WorkspaceRequest,
  type WorkspaceResult,
} from '@shared/ipc/workspace';
import { LocalFileBrowserService } from '../providers/local/local-file-browser-service';
import { discoverLocalDrives } from '../providers/local/local-drives';
import { createValidatedIpcHandler } from './validated-handler';
import {
  localDirectoryRequestSchema,
  localDirectoryResponseSchema,
  localDrivesRequestSchema,
  localDrivesResponseSchema,
  runtimeInfoRequestSchema,
  runtimeInfoResponseSchema,
  runtimePlatformSchema,
} from './schemas';

type RegisteredIpcHandler = (request: unknown) => Promise<unknown>;

export interface IpcHandlerRegistrar {
  readonly handle: (channel: string, handler: RegisteredIpcHandler) => void;
}

export interface IpcHandlerDependencies {
  readonly workspace?: (request: WorkspaceRequest) => Promise<WorkspaceResult>;
  readonly getRuntimeInfo: () => Promise<RuntimeInfo> | RuntimeInfo;
  readonly listLocalDrives: () => Promise<readonly LocalDrive[]> | readonly LocalDrive[];
  readonly listLocalDirectory: (
    request: LocalDirectoryRequest,
  ) => Promise<LocalDirectoryListing> | LocalDirectoryListing;
}

export interface IpcHandlerDependencyOptions {
  readonly getDriveIcon?: (path: string) => Promise<string | undefined>;
  readonly allowMultipleDrives: boolean;
  readonly localInitialPath: string;
  readonly localRootPath: string;
}

export const createIpcHandlerDependencies = (
  options: IpcHandlerDependencyOptions,
): IpcHandlerDependencies => {
  const icons = new Map<string, string>();
  const localFileBrowserService = new LocalFileBrowserService(options.localInitialPath, async () =>
    options.allowMultipleDrives
      ? discoverLocalDrives(options.localRootPath)
      : [{ label: options.localRootPath, path: options.localRootPath }],
  );

  return {
    getRuntimeInfo: () => ({
      platform: runtimePlatformSchema.parse(process.platform),
      runtime: 'electron',
    }),
    listLocalDirectory: (request) => localFileBrowserService.list(request),
    listLocalDrives: async () =>
      Promise.all(
        (await localFileBrowserService.listDrives()).map(async (drive) => {
          let icon = icons.get(drive.path);
          if (!icon && options.getDriveIcon) {
            try {
              icon = await options.getDriveIcon(drive.path);
            } catch {
              icon = undefined;
            }
            if (icon) icons.set(drive.path, icon);
          }
          return { ...drive, ...(icon ? { icon } : {}) };
        }),
      ),
  };
};

export const registerIpcHandlers = (
  registrar: IpcHandlerRegistrar,
  dependencies: IpcHandlerDependencies,
): void => {
  if (dependencies.workspace)
    registrar.handle(
      ipcRequestChannels.workspace,
      createValidatedIpcHandler({
        handle: dependencies.workspace,
        requestSchema: z.strictObject({
          correlationId: z.string().uuid(),
          payload: workspaceRequestSchema,
        }),
        responseSchema: workspaceResultSchema,
      }),
    );
  registrar.handle(
    ipcRequestChannels.listLocalDrives,
    createValidatedIpcHandler({
      handle: dependencies.listLocalDrives,
      requestSchema: localDrivesRequestSchema,
      responseSchema: localDrivesResponseSchema,
    }),
  );
  registrar.handle(
    ipcRequestChannels.getRuntimeInfo,
    createValidatedIpcHandler({
      handle: dependencies.getRuntimeInfo,
      requestSchema: runtimeInfoRequestSchema,
      responseSchema: runtimeInfoResponseSchema,
    }),
  );
  registrar.handle(
    ipcRequestChannels.listLocalDirectory,
    createValidatedIpcHandler({
      handle: dependencies.listLocalDirectory,
      requestSchema: localDirectoryRequestSchema,
      responseSchema: localDirectoryResponseSchema,
    }),
  );
};
