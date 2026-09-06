import type { WorkspaceRequest, WorkspaceSnapshot } from '@shared/ipc/workspace';
import type { IconName } from './Icon';

export type PaneSide = 'left' | 'right';
export interface PaneLocation {
  readonly path: string;
  readonly title: string;
  readonly kind: 'local' | 'sftp' | 's3';
  readonly ready: boolean;
  readonly writable: boolean;
}
export const panelId = (workspaceId: string, side: PaneSide): string => `${workspaceId}:${side}`;
export const sessionPaneId = (
  snapshot: WorkspaceSnapshot,
  workspaceId: string,
  side: PaneSide,
): string =>
  side === 'right' && snapshot.sessions.some((session) => session.workspaceId === workspaceId)
    ? workspaceId
    : panelId(workspaceId, side);
export const workspaceIds = (workspaceId: string): readonly string[] => [
  workspaceId,
  panelId(workspaceId, 'left'),
  panelId(workspaceId, 'right'),
];
export const workspaceOf = (id: string): string => id.replace(/:(left|right)$/u, '');
export const protocolIcon = (kind: 'local' | 'sftp' | 's3'): IconName =>
  kind === 's3' ? 'Database' : kind === 'sftp' ? 'ShieldCheck' : 'HardDrive';
export const directoryName = (path: string): string =>
  path
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]/u)
    .at(-1) || path;
export const workspaceTitle = (
  left: PaneLocation | undefined,
  right: PaneLocation | undefined,
  fallback: string,
): string =>
  left && right
    ? `${directoryName(left.path) || left.title} - ${right.kind === 'local' ? directoryName(right.path) : right.title}`
    : fallback;
export const hasWorkspaceConnection = (snapshot: WorkspaceSnapshot, workspaceId: string): boolean =>
  snapshot.sessions.some((session) => workspaceIds(workspaceId).includes(session.workspaceId));
export type FileTransferRequest = Extract<
  WorkspaceRequest,
  { action: 'local-transfer' | 'remote-transfer' | 'transfer' }
>;
export const copyRequest = (
  sourceId: string,
  sourceKind: PaneLocation['kind'],
  sourcePath: string,
  destinationId: string,
  destination: PaneLocation,
): FileTransferRequest => {
  if (sourceKind === 'local' && destination.kind === 'local')
    return {
      action: 'local-transfer',
      workspaceId: sourceId,
      sourcePath,
      destinationDirectory: destination.path,
      conflictPolicy: 'ask',
    };
  if (sourceKind !== 'local' && destination.kind !== 'local')
    return {
      action: 'remote-transfer',
      workspaceId: sourceId,
      destinationWorkspaceId: destinationId,
      sourcePath,
      destinationDirectory: destination.path,
      conflictPolicy: 'ask',
    };
  return {
    action: 'transfer',
    workspaceId: sourceKind === 'local' ? destinationId : sourceId,
    direction: sourceKind === 'local' ? 'upload' : 'download',
    sourcePath,
    destinationDirectory: destination.path,
    conflictPolicy: 'ask',
  };
};
