import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TransferSnapshot } from '@shared/models/transfer-snapshot';
import { TransferQueue } from './TransferQueue';

const transfer: TransferSnapshot = {
  id: 'failed-transfer',
  workspaceId: 'workspace-1',
  sourcePath: '/certbot',
  destinationPath: 'C:\\Hosting\\Sites\\certbot',
  direction: 'download',
  state: 'failed',
  conflictPolicy: 'ask',
  transferredBytes: 0n,
  totalBytes: 0n,
  speed: 0,
  elapsed: 0,
  remaining: null,
  errorKey: 'errors.provider.unsupported',
  conflictPath: null,
};

describe('TransferQueue history cleanup', () => {
  it('offers history cleanup when the queue contains only failed transfers', () => {
    const run = vi.fn(async () => undefined);
    render(<TransferQueue transfers={[transfer]} run={run} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear finished and failed transfers' }));

    expect(run).toHaveBeenCalledExactlyOnceWith({ action: 'clear-transfer-history' });
    expect(screen.getByRole('button', { name: 'Retry / resume' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart from zero' })).toBeTruthy();
  });

  it('does not offer history cleanup for active or pending transfers', () => {
    render(
      <TransferQueue
        transfers={(['running', 'queued', 'paused', 'requiring-review'] as const).map((state) => ({
          ...transfer,
          id: state,
          state,
          errorKey: null,
        }))}
        run={vi.fn(async () => undefined)}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Clear finished and failed transfers' }),
    ).toBeNull();
  });
});
