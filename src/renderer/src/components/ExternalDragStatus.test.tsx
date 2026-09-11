import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalDragSnapshot } from '@shared/ipc/file-drag';
import { ExternalDragStatus } from './ExternalDragStatus';

const snapshot: ExternalDragSnapshot = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: 'workspace-1:right',
  fileCount: 2,
  state: 'preparing',
  transferredBytes: 10n,
  totalBytes: 20n,
  errorKey: null,
};

describe('ExternalDragStatus', () => {
  it('shows progress and cancellation until every file is ready', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<ExternalDragStatus snapshot={snapshot} onDismiss={onDismiss} />);
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('10');
    expect(screen.queryByRole('button', { name: 'Drag into another app' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    rerender(
      <ExternalDragStatus snapshot={{ ...snapshot, state: 'ready' }} onDismiss={onDismiss} />,
    );
    expect(
      screen.getByRole('button', { name: 'Drag into another app' }).getAttribute('draggable'),
    ).toBe('true');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('passes only the preparation identifier and displays native drag errors', async () => {
    const desktop = window.desktop;
    const startFileDrag = vi.fn(async () => ({
      correlationId: 'drag',
      ok: false as const,
      error: { code: 'PROVIDER_NOT_FOUND' as const, messageKey: 'errors.provider.notFound' },
    }));
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { ...desktop, startFileDrag },
    });
    try {
      render(<ExternalDragStatus snapshot={{ ...snapshot, state: 'ready' }} onDismiss={vi.fn()} />);
      fireEvent.dragStart(screen.getByRole('button', { name: 'Drag into another app' }));
      expect(startFileDrag).toHaveBeenCalledWith({ source: 'prepared', id: snapshot.id });
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    } finally {
      Object.defineProperty(window, 'desktop', { configurable: true, value: desktop });
    }
  });
});
