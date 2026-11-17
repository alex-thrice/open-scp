import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopApi } from '@shared/desktop-api';
import type {
  IpcEventEnvelope,
  IpcFailureResponse,
  LocalDirectoryChangedEvent,
  LocalDirectoryEntry,
  LocalDirectoryListing,
} from '@shared/ipc/contracts';
import { defaultAppearance, type WorkspaceSnapshot } from '@shared/ipc/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePane } from './FilePane';

const originalDesktop = window.desktop;
const correlationId = '00000000-0000-4000-8000-000000000001';
const path = 'C:\\fixture';
const subscriptionId = 'workspace-1:left';
const snapshot: WorkspaceSnapshot = { profiles: [], sessions: [], transfers: [], language: null };
const createEntry = (name: string): LocalDirectoryEntry => ({
  name,
  path: `${path}\\${name}`,
  kind: 'file',
  modifiedAt: null,
  size: 1n,
});

const createFixture = (initialEntries: LocalDirectoryEntry[], initialPath = path) => {
  let listing: LocalDirectoryListing = {
    breadcrumbs: [{ label: path, path }],
    currentPath: path,
    entries: initialEntries,
    parentPath: null,
  };
  const failure: IpcFailureResponse = {
    correlationId,
    ok: false,
    error: { code: 'PROVIDER_NOT_FOUND', messageKey: 'errors.provider.notFound' },
  };
  let shouldFail = false;
  let rejectedPath: string | null = null;
  const listeners = new Set<(event: IpcEventEnvelope<LocalDirectoryChangedEvent>) => void>();
  const listLocalDirectory = vi.fn<DesktopApi['listLocalDirectory']>(async (requestedPath) =>
    shouldFail || (rejectedPath !== null && rejectedPath === requestedPath)
      ? failure
      : { correlationId, data: listing, ok: true as const },
  );
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      ...originalDesktop,
      listLocalDirectory,
      setLocalDirectoryWatch: async () => ({ correlationId, ok: true, data: null }),
      onLocalDirectoryChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies DesktopApi,
  });
  const run = vi.fn(async () => undefined);
  const component = (
    <FilePane
      paneId={subscriptionId}
      side="left"
      active
      isActive
      initialPath={initialPath}
      initialized
      snapshot={snapshot}
      run={run}
      errorKey={null}
      appearance={defaultAppearance}
      destination={undefined}
      destinationId="workspace-1:right"
      isConnecting={false}
      onConnect={vi.fn()}
      onActivate={vi.fn()}
      onLocation={vi.fn()}
    />
  );
  const notifyChange = async (): Promise<void> => {
    await act(async () => {
      for (const listener of listeners)
        listener({ correlationId, payload: { subscriptionId, path } });
    });
  };
  const changeEntries = async (entries: LocalDirectoryEntry[]): Promise<void> => {
    listing = { ...listing, entries };
    shouldFail = false;
    await notifyChange();
  };
  const failRefresh = async (): Promise<void> => {
    shouldFail = true;
    await notifyChange();
  };
  const ready = async (): Promise<void> => {
    await waitFor(() => expect(listeners.size).toBe(1));
    await waitFor(() => expect(listLocalDirectory).toHaveBeenCalledTimes(2));
  };
  return {
    component,
    changeEntries,
    failRefresh,
    ready,
    run,
    rejectPath: (value: string) => {
      rejectedPath = value;
    },
  };
};

afterEach(() => {
  Object.defineProperty(window, 'desktop', { configurable: true, value: originalDesktop });
});

describe('FilePane background refresh focus', () => {
  it('keeps keyboard focus through deletion of the last file and subsequent creation', async () => {
    const fixture = createFixture([createEntry('old.txt')]);
    const { container } = render(fixture.component);
    await fixture.ready();
    fireEvent.click(screen.getByRole('row', { name: 'old.txt' }));

    await fixture.changeEntries([]);
    expect(screen.queryByTestId('file-row')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.commander-surface'));

    await fixture.changeEntries([createEntry('new.txt')]);
    const row = screen.getByRole('row', { name: 'new.txt' });
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(fixture.run).toHaveBeenLastCalledWith({
      action: 'open-local-file',
      workspaceId: subscriptionId,
      path: `${path}\\new.txt`,
    });
  });

  it('leaves another control focused while the list disappears and reappears', async () => {
    const fixture = createFixture([createEntry('old.txt')]);
    render(
      <>
        <input aria-label="Other pane" />
        {fixture.component}
      </>,
    );
    await fixture.ready();
    fireEvent.click(screen.getByRole('row', { name: 'old.txt' }));
    const input = screen.getByRole('textbox', { name: 'Other pane' });
    act(() => input.focus());

    await fixture.changeEntries([]);
    expect(document.activeElement).toBe(input);
    await fixture.changeEntries([createEntry('new.txt')]);
    expect(document.activeElement).toBe(input);
  });

  it('does not focus a new row when the empty pane did not have focus', async () => {
    const fixture = createFixture([]);
    render(fixture.component);
    await fixture.ready();
    expect(document.activeElement).toBe(document.body);

    await fixture.changeEntries([createEntry('new.txt')]);
    expect(screen.getByRole('row', { name: 'new.txt' })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('clears a background error after recovery when the displayed path was normalized', async () => {
    const fixture = createFixture([createEntry('old.txt')], `${path}\\`);
    render(fixture.component);
    await fixture.ready();

    await fixture.failRefresh();
    expect(screen.getByRole('alert')).toBeTruthy();
    await fixture.changeEntries([createEntry('new.txt')]);
    expect(screen.getByRole('row', { name: 'new.txt' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves a failed navigation error when the old directory refresh succeeds', async () => {
    const fixture = createFixture([createEntry('old.txt')]);
    const { container } = render(fixture.component);
    await fixture.ready();
    const invalidPath = 'C:\\missing';
    fixture.rejectPath(invalidPath);
    const input = container.querySelector<HTMLInputElement>('.address-form input');
    if (!input?.form) throw new Error('The path form is missing.');
    fireEvent.change(input, { target: { value: invalidPath } });
    fireEvent.submit(input.form);
    await screen.findByRole('alert');

    await fixture.changeEntries([createEntry('updated.txt')]);
    expect(screen.getByRole('row', { name: 'updated.txt' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
