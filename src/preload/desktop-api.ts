import {
  applicationErrorCodes,
  getSafeApplicationError,
  type ApplicationErrorCode,
} from '@shared/errors/application-error';
import type { DesktopApi } from '@shared/desktop-api';
import type { FileDragRequest } from '@shared/ipc/file-drag';
import {
  workspaceResultSchema,
  type WorkspaceRequest,
  type WorkspaceResult,
} from '@shared/ipc/workspace';
import { ipcEventChannels, ipcRequestChannels } from '@shared/ipc/channels';
import type {
  AppReadyEvent,
  ApplicationMenuCommand,
  ApplicationMenuCommandEvent,
  IpcEventEnvelope,
  IpcResponseEnvelope,
  LocalDirectoryEntry,
  LocalDirectoryListing,
  LocalDrive,
  RuntimeInfo,
  RuntimePlatform,
} from '@shared/ipc/contracts';

export interface PreloadIpcBridge {
  readonly invoke: (channel: string, request: unknown) => Promise<unknown>;
  readonly subscribe: (channel: string, listener: (payload: unknown) => void) => () => void;
}

const runtimePlatforms = new Set<RuntimePlatform>([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);

const applicationErrorCodeSet = new Set<ApplicationErrorCode>(Object.values(applicationErrorCodes));
const fileSystemEntryKinds = new Set(['directory', 'file', 'special', 'symbolic-link']);
const applicationMenuCommands = new Set<ApplicationMenuCommand>([
  'new-workspace',
  'close-workspace',
  'connections',
  'settings',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isCorrelationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

const isRuntimePlatform = (value: unknown): value is RuntimePlatform =>
  typeof value === 'string' && runtimePlatforms.has(value as RuntimePlatform);

const isApplicationErrorCode = (value: unknown): value is ApplicationErrorCode =>
  typeof value === 'string' && applicationErrorCodeSet.has(value as ApplicationErrorCode);

const isSafeApplicationError = (value: unknown): boolean => {
  if (!isRecord(value) || !isApplicationErrorCode(value.code)) {
    return false;
  }

  return value.messageKey === getSafeApplicationError(value.code).messageKey;
};

const isResponseEnvelope = <Data>(
  value: unknown,
  isData: (data: unknown) => data is Data,
): value is IpcResponseEnvelope<Data> => {
  if (!isRecord(value) || !isCorrelationId(value.correlationId) || typeof value.ok !== 'boolean') {
    return false;
  }

  if (value.ok) {
    return isData(value.data);
  }

  return isSafeApplicationError(value.error);
};

const isRuntimeInfo = (value: unknown): value is RuntimeInfo =>
  isRecord(value) && value.runtime === 'electron' && isRuntimePlatform(value.platform);

const isLocalDirectoryEntry = (value: unknown): value is LocalDirectoryEntry =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  fileSystemEntryKinds.has(value.kind) &&
  (value.modifiedAt === null ||
    (typeof value.modifiedAt === 'string' && !Number.isNaN(Date.parse(value.modifiedAt)))) &&
  typeof value.name === 'string' &&
  value.name.length > 0 &&
  typeof value.path === 'string' &&
  value.path.length > 0 &&
  typeof value.size === 'bigint' &&
  value.size >= 0n;

const isLocalDirectoryListing = (value: unknown): value is LocalDirectoryListing =>
  isRecord(value) &&
  Array.isArray(value.breadcrumbs) &&
  value.breadcrumbs.every(
    (breadcrumb) =>
      isRecord(breadcrumb) &&
      typeof breadcrumb.label === 'string' &&
      breadcrumb.label.length > 0 &&
      typeof breadcrumb.path === 'string' &&
      breadcrumb.path.length > 0,
  ) &&
  typeof value.currentPath === 'string' &&
  value.currentPath.length > 0 &&
  Array.isArray(value.entries) &&
  value.entries.every(isLocalDirectoryEntry) &&
  (value.parentPath === null ||
    (typeof value.parentPath === 'string' && value.parentPath.length > 0));

const isLocalDrives = (value: unknown): value is readonly LocalDrive[] =>
  Array.isArray(value) &&
  value.every(
    (drive) =>
      isRecord(drive) &&
      typeof drive.label === 'string' &&
      drive.label.length > 0 &&
      typeof drive.path === 'string' &&
      drive.path.length > 0,
  );

const isAppReadyEvent = (value: unknown): value is IpcEventEnvelope<AppReadyEvent> =>
  isRecord(value) &&
  isCorrelationId(value.correlationId) &&
  isRecord(value.payload) &&
  typeof value.payload.occurredAt === 'string' &&
  !Number.isNaN(Date.parse(value.payload.occurredAt));

const isApplicationMenuCommandEvent = (
  value: unknown,
): value is IpcEventEnvelope<ApplicationMenuCommandEvent> =>
  isRecord(value) &&
  isCorrelationId(value.correlationId) &&
  isRecord(value.payload) &&
  typeof value.payload.command === 'string' &&
  applicationMenuCommands.has(value.payload.command as ApplicationMenuCommand);

const parseResponse = <Data>(
  value: unknown,
  correlationId: string,
  isData: (data: unknown) => data is Data,
): IpcResponseEnvelope<Data> => {
  if (isResponseEnvelope(value, isData) && value.correlationId === correlationId) {
    return value;
  }

  return {
    correlationId,
    error: getSafeApplicationError(applicationErrorCodes.invalidIpcResponse),
    ok: false,
  };
};

export const createDesktopApi = (
  bridge: PreloadIpcBridge,
  createCorrelationId: () => string = () => crypto.randomUUID(),
): DesktopApi =>
  Object.freeze({
    startFileDrag: async (request: FileDragRequest): Promise<IpcResponseEnvelope<null>> => {
      const correlationId = createCorrelationId();
      try {
        const response = await bridge.invoke(ipcRequestChannels.startFileDrag, {
          correlationId,
          payload: request,
        });
        return parseResponse(response, correlationId, (value): value is null => value === null);
      } catch {
        return {
          correlationId,
          error: getSafeApplicationError(applicationErrorCodes.ipcUnavailable),
          ok: false,
        };
      }
    },
    workspace: async (request: WorkspaceRequest): Promise<IpcResponseEnvelope<WorkspaceResult>> => {
      const correlationId = createCorrelationId();
      try {
        const response = await bridge.invoke(ipcRequestChannels.workspace, {
          correlationId,
          payload: request,
        });
        return parseResponse(
          response,
          correlationId,
          (value): value is WorkspaceResult => workspaceResultSchema.safeParse(value).success,
        );
      } catch {
        return {
          correlationId,
          error: getSafeApplicationError(applicationErrorCodes.ipcUnavailable),
          ok: false,
        };
      }
    },
    getRuntimeInfo: async (): Promise<IpcResponseEnvelope<RuntimeInfo>> => {
      const correlationId = createCorrelationId();

      try {
        const response = await bridge.invoke(ipcRequestChannels.getRuntimeInfo, {
          correlationId,
          payload: {},
        });

        return parseResponse(response, correlationId, isRuntimeInfo);
      } catch {
        return {
          correlationId,
          error: getSafeApplicationError(applicationErrorCodes.ipcUnavailable),
          ok: false,
        };
      }
    },
    listLocalDirectory: async (
      path: string | null,
    ): Promise<IpcResponseEnvelope<LocalDirectoryListing>> => {
      const correlationId = createCorrelationId();

      try {
        const response = await bridge.invoke(ipcRequestChannels.listLocalDirectory, {
          correlationId,
          payload: { path },
        });

        return parseResponse(response, correlationId, isLocalDirectoryListing);
      } catch {
        return {
          correlationId,
          error: getSafeApplicationError(applicationErrorCodes.ipcUnavailable),
          ok: false,
        };
      }
    },
    listLocalDrives: async (): Promise<IpcResponseEnvelope<readonly LocalDrive[]>> => {
      const correlationId = createCorrelationId();

      try {
        const response = await bridge.invoke(ipcRequestChannels.listLocalDrives, {
          correlationId,
          payload: {},
        });

        return parseResponse(response, correlationId, isLocalDrives);
      } catch {
        return {
          correlationId,
          error: getSafeApplicationError(applicationErrorCodes.ipcUnavailable),
          ok: false,
        };
      }
    },
    onAppReady: (listener: (event: IpcEventEnvelope<AppReadyEvent>) => void): (() => void) =>
      bridge.subscribe(ipcEventChannels.appReady, (payload: unknown) => {
        if (isAppReadyEvent(payload)) {
          listener(payload);
        }
      }),
    onApplicationMenuCommand: (
      listener: (event: IpcEventEnvelope<ApplicationMenuCommandEvent>) => void,
    ): (() => void) =>
      bridge.subscribe(ipcEventChannels.applicationMenuCommand, (payload: unknown) => {
        if (isApplicationMenuCommandEvent(payload)) listener(payload);
      }),
    runtime: 'electron',
  });
