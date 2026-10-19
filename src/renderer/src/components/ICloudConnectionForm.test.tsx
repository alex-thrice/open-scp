import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ICloudConnectionForm } from './ICloudConnectionForm';
import type { WorkspaceRunner } from './useWorkspaceService';
import type { WorkspaceResult } from '@shared/ipc/workspace';
import { i18n } from '../i18n';

const result: WorkspaceResult = {
  snapshot: { profiles: [], sessions: [], transfers: [], language: null },
  listing: null,
  privateKeyPath: null,
};
const fillAccount = () => {
  fireEvent.change(screen.getByLabelText('Profile name'), {
    target: { value: 'My Apple account' },
  });
  fireEvent.change(screen.getByLabelText('Apple Account email'), {
    target: { value: 'user+tag@example.invalid' },
  });
  fireEvent.change(screen.getByLabelText('Apple Account password'), {
    target: { value: 'password-canary' },
  });
};

describe('iCloud account setup form', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('collects credentials once, asks for 2FA, then saves only profile metadata', async () => {
    const onConfirm = vi.fn();
    const run = vi.fn<WorkspaceRunner>(async (request) => {
      if (request.action === 'start-icloud-configuration')
        return {
          ...result,
          icloudConfiguration: {
            id: request.id,
            status: 'question',
            kind: 'verification-code',
            choices: [],
            retry: false,
          },
        };
      if (request.action === 'continue-icloud-configuration')
        return { ...result, icloudConfiguration: { id: request.id, status: 'complete' } };
      return { ...result, savedProfileId: 'ae7e5280-84b1-4f07-8112-6f9d8a4b8c08' };
    });
    render(
      <ICloudConnectionForm
        profile={undefined}
        run={run}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        errorKey={null}
      />,
    );
    fillAccount();
    expect(screen.getByLabelText('Connection name in rclone').matches(':disabled')).toBe(true);
    expect((screen.getByLabelText('Connection name in rclone') as HTMLInputElement).value).toBe(
      'user+tag@example.invalid',
    );
    fireEvent.change(screen.getByLabelText('Apple Account email'), {
      target: { value: 'user!tag@example.invalid' },
    });
    expect(screen.getByRole('alert').textContent).toContain('rclone does not allow');
    expect(
      (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Apple Account email'), {
      target: { value: 'user+tag@example.invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    const code = await screen.findByLabelText('Verification code');
    expect((screen.getByLabelText('Apple Account password') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Connection name in rclone').matches(':disabled')).toBe(true);
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    const saved = run.mock.calls.find(([request]) => request.action === 'save-icloud-profile')?.[0];
    expect(saved).toMatchObject({
      profile: { name: 'My Apple account', remote: 'user+tag@example.invalid' },
    });
    expect(JSON.stringify(saved)).not.toMatch(/password-canary|123456/u);
  });

  it('uses a preconfigured remote without collecting or sending Apple credentials', async () => {
    const run = vi.fn<WorkspaceRunner>(async () => ({
      ...result,
      savedProfileId: 'ae7e5280-84b1-4f07-8112-6f9d8a4b8c08',
    }));
    const close = vi.fn();
    render(
      <ICloudConnectionForm
        profile={undefined}
        icloudRemotes={['legacy_account', 'user+tag@example.invalid']}
        run={run}
        onClose={close}
        errorKey={null}
      />,
    );
    fireEvent.change(screen.getByLabelText('Account setup'), { target: { value: 'existing' } });
    fireEvent.change(screen.getByLabelText('Profile name'), {
      target: { value: 'Existing account' },
    });
    expect(screen.queryByLabelText('Apple Account password')).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Connection name in rclone') as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Connection name in rclone'), {
      target: { value: 'user+tag@example.invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith({ action: 'refresh-rclone' });
    expect(
      run.mock.calls.some(([request]) => request.action === 'start-icloud-configuration'),
    ).toBe(false);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'save-icloud-profile',
        profile: expect.objectContaining({ remote: 'user+tag@example.invalid' }),
      }),
    );
  });

  it('allows cancelling a pending sign-in and returns to the credential form without saving', async () => {
    let finish: ((value: WorkspaceResult) => void) | undefined;
    const run = vi.fn<WorkspaceRunner>(async (request) => {
      if (request.action === 'start-icloud-configuration')
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (request.action === 'cancel-icloud-configuration')
        finish?.({ ...result, icloudConfiguration: { id: request.id, status: 'cancelled' } });
      return result;
    });
    render(
      <ICloudConnectionForm profile={undefined} run={run} onClose={vi.fn()} errorKey={null} />,
    );
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(run.mock.calls.some(([request]) => request.action === 'save-icloud-profile')).toBe(
      false,
    );
    expect(screen.queryByLabelText('Verification code')).toBeNull();
  });
});
