import { describe, expect, it } from 'vitest';
import {
  copyRequest,
  workspaceTitle,
  workspaceOf,
  sessionPaneId,
  type PaneLocation,
} from './workspace-layout';

const location = (kind: PaneLocation['kind'], path: string): PaneLocation => ({
  kind,
  path,
  title: 'Server',
  ready: true,
  writable: true,
});
describe('workspace layout', () => {
  it('routes all local and remote copy combinations through the queue with conflict review', () => {
    for (const source of ['local', 'sftp', 's3', 'ftp'] as const) {
      for (const target of ['local', 'sftp', 's3', 'ftp'] as const) {
        const request = copyRequest(
          'one:left',
          source,
          '/source',
          'one:right',
          location(target, '/target'),
        );
        expect(request.conflictPolicy).toBe('ask');
        expect(request.destinationDirectory).toBe('/target');
        if (source === 'local' && target === 'local') expect(request.action).toBe('local-transfer');
        else if (source !== 'local' && target !== 'local')
          expect(request).toMatchObject({
            action: 'remote-transfer',
            workspaceId: 'one:left',
            destinationWorkspaceId: 'one:right',
          });
        else
          expect(request).toMatchObject({
            action: 'transfer',
            direction: source === 'local' ? 'upload' : 'download',
            workspaceId: source === 'local' ? 'one:right' : 'one:left',
          });
      }
    }
  });
  it('names tabs by folder and remote profile while supporting legacy workspace IDs', () => {
    expect(
      workspaceTitle(location('local', '/home/alex'), location('local', '/tmp/files'), ''),
    ).toBe('alex - files');
    expect(
      workspaceTitle(location('local', '/home/alex'), location('s3', '/bucket/prefix'), ''),
    ).toBe('alex - Server');
    expect(workspaceOf('workspace-2:right')).toBe('workspace-2');
    expect(
      sessionPaneId(
        {
          profiles: [],
          transfers: [],
          language: null,
          sessions: [
            {
              workspaceId: 'workspace-2',
              profileId: 'p',
              name: 'Server',
              state: 'connected',
              hostKey: null,
            },
          ],
        },
        'workspace-2',
        'right',
      ),
    ).toBe('workspace-2');
  });
});
