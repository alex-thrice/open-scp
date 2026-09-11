import { fireEvent, render, screen } from '@testing-library/react';
import type { LocalDirectoryEntry } from '@shared/ipc/contracts';
import { describe, expect, it, vi } from 'vitest';
import { VirtualFileList } from './VirtualFileList';

describe('VirtualFileList', () => {
  it('starts a native drag for selected local files and preserves internal drags for folders and remote files', () => {
    const desktop = window.desktop;
    const startFileDrag = vi.fn(async () => ({
      correlationId: 'drag',
      ok: true as const,
      data: null,
    }));
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: { ...desktop, startFileDrag },
    });
    try {
      const entries: LocalDirectoryEntry[] = [
        { name: 'one.txt', path: '/one.txt', kind: 'file', modifiedAt: null, size: 1n },
        { name: 'two.txt', path: '/two.txt', kind: 'file', modifiedAt: null, size: 1n },
        { name: 'folder', path: '/folder', kind: 'directory', modifiedAt: null, size: 0n },
      ];
      const localSource = {
        workspaceId: 'workspace-1:left',
        side: 'local' as const,
        kind: 'local' as const,
      };
      const { rerender } = render(
        <VirtualFileList
          entries={entries}
          onOpenDirectory={vi.fn()}
          selectedPaths={['/one.txt', '/two.txt']}
          dragSource={localSource}
        />,
      );
      const setData = vi.fn();
      expect(
        fireEvent.dragStart(screen.getByRole('row', { name: 'one.txt' }), {
          dataTransfer: { setData },
        }),
      ).toBe(false);
      expect(startFileDrag).toHaveBeenCalledWith({
        source: 'local',
        paths: ['/one.txt', '/two.txt'],
      });
      expect(setData).not.toHaveBeenCalled();
      fireEvent.dragStart(screen.getByRole('row', { name: 'Open folder' }), {
        dataTransfer: { setData },
      });
      expect(setData).toHaveBeenLastCalledWith(
        'application/x-openscp',
        JSON.stringify({ ...localSource, paths: ['/folder'] }),
      );
      const remoteSource = {
        workspaceId: 'workspace-1:right',
        side: 'remote' as const,
        kind: 'sftp' as const,
      };
      rerender(
        <VirtualFileList entries={entries} onOpenDirectory={vi.fn()} dragSource={remoteSource} />,
      );
      fireEvent.dragStart(screen.getByRole('row', { name: 'two.txt' }), {
        dataTransfer: { setData },
      });
      expect(setData).toHaveBeenLastCalledWith(
        'application/x-openscp',
        JSON.stringify({ ...remoteSource, paths: ['/two.txt'] }),
      );
      expect(startFileDrag).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'desktop', { configurable: true, value: desktop });
    }
  });
  it('keeps a 100,000-entry directory virtualized and interactive', () => {
    const entries: LocalDirectoryEntry[] = Array.from({ length: 100_000 }, (_, index) => ({
      kind: 'file',
      modifiedAt: '2026-08-30T12:00:00.000Z',
      name: `file-${String(index).padStart(6, '0')}.bin`,
      path: `C:\\fixture\\file-${index}.bin`,
      size: BigInt(index),
    }));

    render(<VirtualFileList entries={entries} onOpenDirectory={vi.fn()} />);

    expect(screen.getAllByTestId('file-row').length).toBeLessThan(40);
    expect(screen.getByTestId('file-list-canvas').style.height).toBe('3600000px');
    expect(screen.getByText('file-000000.bin')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sort Name descending' }));

    expect(screen.getByText('file-099999.bin')).toBeTruthy();
    expect(screen.getAllByTestId('file-row').length).toBeLessThan(40);
  });

  it('opens an editable incremental search and moves through matches', () => {
    const entries: LocalDirectoryEntry[] = [
      {
        kind: 'file',
        modifiedAt: null,
        name: 'notes-first.txt',
        path: 'C:\\fixture\\notes-first.txt',
        size: 1n,
      },
      {
        kind: 'file',
        modifiedAt: null,
        name: 'notes-second.txt',
        path: 'C:\\fixture\\notes-second.txt',
        size: 2n,
      },
      {
        kind: 'file',
        modifiedAt: null,
        name: 'report.txt',
        path: 'C:\\fixture\\report.txt',
        size: 3n,
      },
    ];
    const onSelectionChange = vi.fn();

    render(
      <VirtualFileList
        entries={entries}
        onOpenDirectory={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    const first = screen.getByRole('row', { name: 'notes-first.txt' });
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: 'n' });
    const search = screen.getByRole('searchbox', { name: 'Search files and folders' });
    expect((search as HTMLInputElement).value).toBe('n');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['C:\\fixture\\notes-first.txt']);

    fireEvent.change(search, { target: { value: 'notes' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['C:\\fixture\\notes-second.txt']);
    expect(screen.getByRole('status').textContent).toBe('2 of 2');

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['C:\\fixture\\notes-first.txt']);
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByRole('status').textContent).toBe('No matches');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('opens only files through the file callback', () => {
    const onOpenDirectory = vi.fn();
    const onOpenFile = vi.fn();
    const entries: LocalDirectoryEntry[] = [
      {
        kind: 'directory',
        modifiedAt: null,
        name: 'folder',
        path: 'C:\\fixture\\folder',
        size: 0n,
      },
      {
        kind: 'file',
        modifiedAt: null,
        name: 'notes.txt',
        path: 'C:\\fixture\\notes.txt',
        size: 1n,
      },
    ];

    render(
      <VirtualFileList
        entries={entries}
        onOpenDirectory={onOpenDirectory}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.doubleClick(screen.getByRole('row', { name: 'Open folder' }));
    fireEvent.doubleClick(screen.getByRole('row', { name: 'notes.txt' }));
    expect(onOpenDirectory).toHaveBeenCalledWith('C:\\fixture\\folder');
    expect(onOpenFile).toHaveBeenCalledWith('C:\\fixture\\notes.txt');
  });
});
