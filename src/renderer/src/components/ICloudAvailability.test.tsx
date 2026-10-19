import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import { ConnectionEditor } from './ConnectionEditor';
import { SourcePicker } from './SourcePicker';

const profile = {
  id: 'icloud-profile',
  name: 'Personal iCloud',
  kind: 'icloud' as const,
  remote: 'personal',
};
const snapshot: WorkspaceSnapshot = {
  language: null,
  transfers: [],
  sessions: [],
  profiles: [
    profile,
    {
      id: 'sftp-profile',
      name: 'Development',
      kind: 'sftp',
      host: 'test.example',
      port: 22,
      username: 'test',
      authentication: { method: 'agent' },
    },
  ],
};

describe('iCloud availability in connection selectors', () => {
  it.each([undefined, false, true])(
    'offers creation with a working rclone even without configured remotes (%j)',
    (rcloneAvailable) => {
      render(
        <ConnectionEditor
          snapshot={{ ...snapshot, ...(rcloneAvailable === undefined ? {} : { rcloneAvailable }) }}
          profile={undefined}
          run={vi.fn()}
          onClose={vi.fn()}
          errorKey={null}
        />,
      );
      const option = within(screen.getByLabelText('Connection type')).queryByRole('option', {
        name: 'iCloud Drive',
      });
      expect(!!option).toBe(!!rcloneAvailable);
    },
  );

  it.each([undefined, [], ['other'], ['personal']])(
    'filters unavailable saved profiles from the source picker (%j)',
    (icloudRemotes) => {
      render(
        <SourcePicker
          snapshot={{ ...snapshot, ...(icloudRemotes ? { icloudRemotes } : {}) }}
          session={undefined}
          rootPath={undefined}
          isActive={false}
          isConnecting={false}
          onConnect={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Drive or connection' }));
      expect(!!screen.queryByRole('option', { name: /Personal iCloud/u })).toBe(
        !!icloudRemotes?.includes('personal'),
      );
      expect(screen.getByRole('option', { name: /Development/u })).toBeTruthy();
    },
  );

  it('keeps an existing profile editable when rclone is unavailable', () => {
    render(
      <ConnectionEditor
        snapshot={snapshot}
        profile={profile}
        run={vi.fn()}
        onClose={vi.fn()}
        errorKey={null}
      />,
    );
    expect(screen.getByLabelText('Connection name in rclone')).toBeTruthy();
    expect((screen.getByLabelText('Connection type') as HTMLSelectElement).disabled).toBe(true);
  });
});
