import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('focuses the input after opening and returns focus to its owner on close', () => {
    const owner = document.createElement('button');
    document.body.append(owner);
    owner.focus();
    const { unmount } = render(
      <Dialog title="Create" onClose={vi.fn()}>
        <input aria-label="Name" data-dialog-autofocus />
        <button type="submit">Confirm</button>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    unmount();
    expect(document.activeElement).toBe(owner);
    owner.remove();
  });

  it('focuses a confirmation as soon as its asynchronous preview is ready', async () => {
    const dialog = (disabled: boolean) => (
      <Dialog title="Delete" onClose={vi.fn()} initialFocus='[data-dialog-result="ok"]'>
        <button disabled={disabled} data-dialog-result="ok">
          Confirm
        </button>
      </Dialog>
    );
    const { rerender } = render(dialog(true));
    rerender(dialog(false));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' })),
    );
  });

  it('returns explicit OK and Cancel results and treats Escape and the close icon as Cancel', () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Confirm" onClose={onClose}>
        <input aria-label="Value" />
        <button type="button" data-dialog-result="cancel">
          Cancel
        </button>
        <button type="button" data-dialog-result="ok">
          OK
        </button>
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText('Value'), { key: 'Enter' });
    expect(onClose).toHaveBeenLastCalledWith('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenLastCalledWith('cancel');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenLastCalledWith('cancel');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenLastCalledWith('cancel');
  });

  it('does not confirm while entering multiple lines or when confirmation is disabled', () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Edit" onClose={onClose}>
        <textarea aria-label="Text" />
        <button type="button" data-dialog-result="ok" disabled>
          OK
        </button>
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText('Text'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
