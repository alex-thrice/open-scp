import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from '@shared/ipc/workspace';
import { defaultKeyboardShortcuts } from '@shared/models/keyboard-shortcuts';
import { defaultUpdateSettings } from '@shared/models/application-update';
import { defaultTransferSettings } from '@shared/models/transfer-settings';
import { SettingsDialog } from './SettingsDialog';
import type { WorkspaceRunner } from './useWorkspaceService';
import { i18n } from '../i18n';

describe('transfer preferences', () => {
  it('edits validated queue limits and restores WinSCP defaults', async () => {
    await i18n.changeLanguage('en');
    const run = vi.fn<WorkspaceRunner>(async () => ({
      snapshot: { profiles: [], sessions: [], transfers: [], language: null },
      listing: null,
      privateKeyPath: null,
    }));
    const dialog = () => (
      <SettingsDialog
        appearance={defaultAppearance}
        confirmTabClose
        editorPath={null}
        initialPage="transfers"
        keyboardShortcuts={defaultKeyboardShortcuts}
        sshTerminalClient="openssh"
        puttyPath={null}
        rclonePath={null}
        rcloneAvailable={false}
        icloudRemoteCount={0}
        rememberPaths
        updateSettings={defaultUpdateSettings}
        transferSettings={{ ...defaultTransferSettings }}
        updateState={undefined}
        run={run}
        errorKey={null}
        onClose={() => undefined}
      />
    );
    const { rerender } = render(dialog());
    const upload = screen.getByLabelText<HTMLInputElement>('Upload: concurrent blocks');
    const download = screen.getByLabelText<HTMLInputElement>('Download: concurrent blocks');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save transfer settings' });
    expect(upload.value).toBe('64');
    expect(download.value).toBe('32');
    fireEvent.change(upload, { target: { value: '129' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(upload, { target: { value: '' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(upload, { target: { value: '1' } });
    fireEvent.change(download, { target: { value: '16' } });
    rerender(dialog());
    expect(upload.value).toBe('1');
    expect(download.value).toBe('16');
    fireEvent.click(screen.getByRole('button', { name: 'Restore WinSCP defaults' }));
    expect(upload.value).toBe('64');
    expect(download.value).toBe('32');
    expect(run).not.toHaveBeenCalled();
    fireEvent.change(upload, { target: { value: '1' } });
    fireEvent.change(download, { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        action: 'set-transfer-settings',
        settings: { sftpUploadConcurrency: 1, sftpDownloadConcurrency: 16 },
      }),
    );
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('SSH terminal preferences', () => {
  it('keeps the selected client editable when saving fails', async () => {
    await i18n.changeLanguage('en');
    const run = vi.fn<WorkspaceRunner>(async () => undefined);
    const onClose = vi.fn();
    render(
      <SettingsDialog
        appearance={defaultAppearance}
        confirmTabClose
        editorPath={null}
        initialPage="advanced"
        keyboardShortcuts={defaultKeyboardShortcuts}
        sshTerminalClient="openssh"
        puttyPath={null}
        rclonePath={null}
        rcloneAvailable={false}
        icloudRemoteCount={0}
        rememberPaths
        updateSettings={defaultUpdateSettings}
        transferSettings={defaultTransferSettings}
        updateState={undefined}
        run={run}
        errorKey="errors.external.failed"
        onClose={onClose}
      />,
    );
    const client = screen.getByLabelText<HTMLSelectElement>('SSH client (Windows)');
    fireEvent.change(client, { target: { value: 'putty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save terminal setting' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        action: 'set-ssh-terminal-client',
        client: 'putty',
      }),
    );
    await waitFor(() => expect(client.disabled).toBe(false));
    expect(client.value).toBe('putty');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.change(client, { target: { value: 'openssh' } });
    expect(
      screen.getByLabelText<HTMLInputElement>('PuTTY executable path (Windows)').disabled,
    ).toBe(true);
  });
});
