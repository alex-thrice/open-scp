import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import { GoogleConnectionForm } from './GoogleConnectionForm';
import type { WorkspaceRunner } from './useWorkspaceService';
import { i18n } from '../i18n';

const profileId = '00000000-0000-4000-8000-000000000001';
const snapshot: WorkspaceSnapshot = {
  profiles: [],
  sessions: [],
  transfers: [],
  language: null,
  rcloneAvailable: true,
  googleRemotes: ['personal-google', 'work-google'],
  icloudRemotes: ['apple-account'],
};
const createRunner = () =>
  vi.fn<WorkspaceRunner>(async () => ({
    snapshot,
    listing: null,
    privateKeyPath: null,
    savedProfileId: profileId,
  }));

describe('Google Drive rclone connection', () => {
  it('selects a Google remote separately from iCloud and saves it without an OAuth flow', async () => {
    await i18n.changeLanguage('en');
    const run = createRunner();
    const onClose = vi.fn();
    render(
      <GoogleConnectionForm
        profile={undefined}
        snapshot={snapshot}
        run={run}
        onClose={onClose}
        errorKey={null}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Google Drive connection in rclone');
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(
      within(select)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['personal-google', 'work-google']);
    expect(screen.queryByRole('button', { name: 'Sign in to Google' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Work Drive' } });
    fireEvent.change(select, { target: { value: 'work-google' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        action: 'save-google-profile',
        profile: {
          id: null,
          name: 'Work Drive',
          remote: 'work-google',
          initialDirectory: '/',
          timeout: 60000,
        },
      }),
    );
    expect(run.mock.calls.map(([request]) => request.action)).toEqual([
      'refresh-rclone',
      'save-google-profile',
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('requires an explicit remote choice when reconfiguring a legacy Google profile', async () => {
    await i18n.changeLanguage('en');
    const run = createRunner();
    render(
      <GoogleConnectionForm
        profile={{ id: profileId, name: 'Previous Google', kind: 'google' }}
        snapshot={snapshot}
        run={run}
        onClose={() => undefined}
        errorKey={null}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Google Drive connection in rclone');
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save profile' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('status').textContent).toContain('previous Google sign-in');
    fireEvent.change(select, { target: { value: 'personal-google' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        action: 'save-google-profile',
        profile: {
          id: profileId,
          name: 'Previous Google',
          remote: 'personal-google',
          initialDirectory: '/',
          timeout: 60000,
        },
      }),
    );
  });

  it('keeps an unavailable remote visible while preventing a connection to another account', async () => {
    await i18n.changeLanguage('en');
    render(
      <GoogleConnectionForm
        profile={{ id: profileId, name: 'Missing work Drive', kind: 'google', remote: 'old-work' }}
        snapshot={snapshot}
        run={createRunner()}
        onClose={() => undefined}
        errorKey={null}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Google Drive connection in rclone');
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('old-work');
    expect(
      within(select).getByRole<HTMLOptionElement>('option', { name: 'old-work (unavailable)' })
        .disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save profile' }).disabled).toBe(
      true,
    );
  });
});
