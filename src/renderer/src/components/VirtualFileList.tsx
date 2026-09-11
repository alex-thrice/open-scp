import type { CSSProperties, UIEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { LocalDirectoryEntry } from '@shared/ipc/contracts';
import { useTranslation } from 'react-i18next';
import { formatSize, formatDate } from '../i18n/format';
import { Icon } from './Icon';

type SortDirection = 'ascending' | 'descending';
type SortKey = 'modifiedAt' | 'name' | 'size';

export interface VirtualFileListProps {
  readonly rowHeight?: number;
  readonly entries: readonly LocalDirectoryEntry[];
  readonly onOpenDirectory: (path: string) => void;
  readonly onOpenFile?: (path: string) => void;
  readonly onSelect?: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly selectedPaths?: readonly string[];
  readonly onSelectionChange?: (paths: string[]) => void;
  readonly dragSource?: {
    readonly workspaceId: string;
    readonly side: 'local' | 'remote';
    readonly kind: 'ftp' | 'local' | 's3' | 'sftp';
  };
}

const overscanRowCount = 8;
const fallbackViewportHeight = 360;

const compareBigInt = (left: bigint, right: bigint): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

export const VirtualFileList = ({
  rowHeight = 36,
  entries,
  onOpenDirectory,
  onOpenFile,
  onSelect,
  selectedPath,
  selectedPaths,
  onSelectionChange,
  dragSource,
}: VirtualFileListProps) => {
  const { i18n, t } = useTranslation();
  const viewportReference = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(fallbackViewportHeight);
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const anchor = useRef(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchPosition, setSearchMatchPosition] = useState(0);
  const searchInputReference = useRef<HTMLInputElement>(null);
  const selection = selectedPaths ?? (selectedPath ? [selectedPath] : []);
  const sortedEntries = useMemo(() => {
    const collator = new Intl.Collator(i18n.resolvedLanguage ?? i18n.language, {
      numeric: true,
      sensitivity: 'base',
    });
    const result = [...entries];

    result.sort((left, right) => {
      const directoryOrder = Number(right.kind === 'directory') - Number(left.kind === 'directory');

      if (directoryOrder !== 0) {
        return directoryOrder;
      }

      const comparison =
        sortKey === 'name'
          ? collator.compare(left.name, right.name)
          : sortKey === 'size'
            ? compareBigInt(left.size, right.size)
            : (left.modifiedAt ?? '').localeCompare(right.modifiedAt ?? '');

      return sortDirection === 'ascending' ? comparison : -comparison;
    });

    return result;
  }, [entries, i18n.language, i18n.resolvedLanguage, sortDirection, sortKey]);
  const findSearchMatches = (query: string): number[] => {
    const normalizedQuery = query.toLocaleLowerCase(i18n.resolvedLanguage ?? i18n.language);
    if (!normalizedQuery) return [];
    return sortedEntries.flatMap((entry, index) =>
      entry.name.toLocaleLowerCase(i18n.resolvedLanguage ?? i18n.language).includes(normalizedQuery)
        ? [index]
        : [],
    );
  };
  const searchMatches = findSearchMatches(searchQuery);

  useEffect(() => {
    if (!isSearchOpen) return;
    requestAnimationFrame(() => {
      const input = searchInputReference.current;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  }, [isSearchOpen]);

  useLayoutEffect(() => {
    const viewport = viewportReference.current;

    if (viewport === null) {
      return undefined;
    }

    const updateViewportHeight = (): void => {
      setViewportHeight(viewport.clientHeight || fallbackViewportHeight);
    };

    updateViewportHeight();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const startIndex = Math.max(Math.floor(scrollTop / rowHeight) - overscanRowCount, 0);
  const select = (index: number, extend: boolean, toggle: boolean) => {
    const entry = sortedEntries[index];
    if (!entry) return;
    let next: string[];
    if (extend)
      next = sortedEntries
        .slice(Math.min(anchor.current, index), Math.max(anchor.current, index) + 1)
        .map((item) => item.path);
    else {
      anchor.current = index;
      next = toggle
        ? selection.includes(entry.path)
          ? selection.filter((path) => path !== entry.path)
          : [...selection, entry.path]
        : [entry.path];
    }
    onSelect?.(entry.path);
    onSelectionChange?.(next);
    setFocusedIndex(index);
  };
  const scrollToRow = (index: number): number => {
    const viewport = viewportReference.current;
    if (!viewport) return 0;
    const bounded = Math.max(0, Math.min(index, sortedEntries.length - 1));
    setFocusedIndex(bounded);
    if (bounded * rowHeight < viewport.scrollTop) viewport.scrollTop = bounded * rowHeight;
    if ((bounded + 1) * rowHeight > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = (bounded + 1) * rowHeight - viewport.clientHeight;
    setScrollTop(viewport.scrollTop);
    return bounded;
  };
  const focusRow = (index: number) => {
    const bounded = scrollToRow(index);
    requestAnimationFrame(() =>
      viewportReference.current
        ?.querySelector<HTMLElement>(`[data-entry-index="${bounded}"]`)
        ?.focus(),
    );
  };
  const selectSearchMatch = (matches: readonly number[], position: number): void => {
    if (matches.length === 0) {
      setSearchMatchPosition(0);
      return;
    }
    const normalizedPosition = (position + matches.length) % matches.length;
    const entryIndex = matches[normalizedPosition];
    if (entryIndex === undefined) return;
    setSearchMatchPosition(normalizedPosition);
    select(entryIndex, false, false);
    scrollToRow(entryIndex);
  };
  const updateSearch = (query: string): void => {
    setSearchQuery(query);
    selectSearchMatch(findSearchMatches(query), 0);
  };
  const closeSearch = (): void => {
    setIsSearchOpen(false);
    const entryIndex = searchMatches[searchMatchPosition] ?? focusedIndex;
    focusRow(entryIndex);
  };
  const visibleRowCount = Math.ceil(viewportHeight / rowHeight) + overscanRowCount * 2;
  const endIndex = Math.min(startIndex + visibleRowCount, sortedEntries.length);
  const visibleEntries = sortedEntries.slice(startIndex, endIndex);

  const updateSort = (nextKey: SortKey): void => {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === 'ascending' ? 'descending' : 'ascending'));
      return;
    }

    setSortKey(nextKey);
    setSortDirection('ascending');
  };

  const createSortLabel = (key: SortKey, column: string): string => {
    const nextDirection =
      sortKey === key && sortDirection === 'ascending' ? 'descending' : 'ascending';

    return t(nextDirection === 'ascending' ? 'fileList.sortAscending' : 'fileList.sortDescending', {
      column,
    });
  };

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const rowStyle = (index: number): CSSProperties => ({
    height: rowHeight,
    transform: `translateY(${index * rowHeight}px)`,
  });

  return (
    <div className="file-list-shell">
      <div
        aria-label={t('fileList.label')}
        className="file-list"
        role="grid"
        aria-multiselectable="true"
        aria-rowcount={sortedEntries.length + 1}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            onSelectionChange?.(sortedEntries.map((entry) => entry.path));
            return;
          }
          if (
            event.key.length === 1 &&
            event.key !== ' ' &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing &&
            (event.target as HTMLElement).closest('[data-testid="file-row"]')
          ) {
            event.preventDefault();
            flushSync(() => {
              setIsSearchOpen(true);
              updateSearch(event.key);
            });
            const input = searchInputReference.current;
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
          }
        }}
      >
        <div className="file-list__header" role="row">
          {(['name', 'size', 'modifiedAt'] as const).map((key) => {
            const column = t(key === 'modifiedAt' ? 'fileList.modified' : `fileList.${key}`);

            return (
              <div
                aria-sort={sortKey === key ? sortDirection : 'none'}
                className={`file-list__cell file-list__cell--${key}`}
                key={key}
                role="columnheader"
              >
                <button
                  aria-label={createSortLabel(key, column)}
                  onClick={() => updateSort(key)}
                  tabIndex={-1}
                  type="button"
                >
                  {column}
                  {sortKey === key ? (
                    <span aria-hidden="true">{sortDirection === 'ascending' ? '▲' : '▼'}</span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="file-list__viewport" onScroll={onScroll} ref={viewportReference}>
          <div
            className="file-list__canvas"
            data-testid="file-list-canvas"
            style={{ height: sortedEntries.length * rowHeight }}
          >
            {visibleEntries.map((entry, visibleIndex) => {
              const entryIndex = startIndex + visibleIndex;
              const isDirectory = entry.kind === 'directory';

              return (
                <div
                  aria-label={
                    isDirectory ? t('fileList.openDirectory', { name: entry.name }) : entry.name
                  }
                  className="file-list__row"
                  data-entry-index={entryIndex}
                  data-testid="file-row"
                  data-selected={selection.includes(entry.path)}
                  aria-selected={selection.includes(entry.path)}
                  aria-rowindex={entryIndex + 2}
                  onClick={(event) => {
                    select(entryIndex, event.shiftKey, event.ctrlKey || event.metaKey);
                    event.currentTarget.focus();
                  }}
                  onContextMenu={() => {
                    if (!selection.includes(entry.path)) select(entryIndex, false, false);
                  }}
                  onFocus={() => {
                    setFocusedIndex(entryIndex);
                    if (!selection.length) select(entryIndex, false, false);
                  }}
                  draggable={!!dragSource && entry.s3Kind !== 'bucket'}
                  onDragStart={(event) => {
                    if (!dragSource) return;
                    const paths = selection.includes(entry.path) ? selection : [entry.path];
                    event.dataTransfer.setData(
                      'application/x-openscp',
                      JSON.stringify({ ...dragSource, paths }),
                    );
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  key={entry.path}
                  onDoubleClick={() => {
                    if (isDirectory) {
                      onOpenDirectory(entry.path);
                    } else {
                      onOpenFile?.(entry.path);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(
                        event.key,
                      )
                    ) {
                      event.preventDefault();
                      const offset =
                        event.key === 'PageDown'
                          ? Math.floor(viewportHeight / rowHeight)
                          : event.key === 'PageUp'
                            ? -Math.floor(viewportHeight / rowHeight)
                            : event.key === 'ArrowDown'
                              ? 1
                              : -1;
                      const index = Math.max(
                        0,
                        Math.min(
                          sortedEntries.length - 1,
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? sortedEntries.length - 1
                              : entryIndex + offset,
                        ),
                      );
                      if (!event.ctrlKey && !event.metaKey) select(index, event.shiftKey, false);
                      focusRow(index);
                    }
                    if (event.key === ' ' || event.key === 'Insert') {
                      event.preventDefault();
                      select(entryIndex, false, true);
                    }
                    if (event.key === 'Enter') {
                      if (isDirectory) onOpenDirectory(entry.path);
                      else onOpenFile?.(entry.path);
                    }
                  }}
                  role="row"
                  style={rowStyle(entryIndex)}
                  tabIndex={
                    entryIndex === Math.min(focusedIndex, sortedEntries.length - 1) ? 0 : -1
                  }
                >
                  <div className="file-list__cell file-list__cell--name" role="gridcell">
                    <span
                      className="entry-icon"
                      title={`${t(`fileList.kinds.${entry.kind}`)}${entry.permissions == null ? '' : ` · ${(entry.permissions & 0o7777).toString(8)}`}`}
                    >
                      <Icon
                        name={
                          isDirectory
                            ? 'Folder'
                            : entry.kind === 'symbolic-link'
                              ? 'ArrowUpRight'
                              : /\.(zip|gz|tar|7z)$/iu.test(entry.name)
                                ? 'FileArchive'
                                : 'FileText'
                        }
                      />
                    </span>
                    <span className="entry-name">{entry.name}</span>
                    {entry.s3Kind ? (
                      <small className="entry-kind">{t(`s3.kinds.${entry.s3Kind}`)}</small>
                    ) : null}
                  </div>
                  <div className="file-list__cell file-list__cell--size" role="gridcell">
                    {isDirectory ? t('common.notAvailable') : formatSize(entry.size, i18n.language)}
                  </div>
                  <div className="file-list__cell file-list__cell--modifiedAt" role="gridcell">
                    {entry.modifiedAt === null
                      ? t('common.notAvailable')
                      : formatDate(entry.modifiedAt, i18n.language)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {isSearchOpen ? (
        <div className="file-list-search" role="search">
          <Icon name="Search" />
          <input
            ref={searchInputReference}
            aria-label={t('fileList.search')}
            type="search"
            value={searchQuery}
            onChange={(event) => updateSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                selectSearchMatch(
                  searchMatches,
                  searchMatchPosition + (event.key === 'ArrowDown' ? 1 : -1),
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const entryIndex = searchMatches[searchMatchPosition];
                const entry = entryIndex === undefined ? undefined : sortedEntries[entryIndex];
                if (entry?.kind === 'directory') onOpenDirectory(entry.path);
                else if (entry) onOpenFile?.(entry.path);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              }
            }}
          />
          <span role="status">
            {searchMatches.length
              ? t('fileList.searchStatus', {
                  current: searchMatchPosition + 1,
                  total: searchMatches.length,
                })
              : t('fileList.noSearchResults')}
          </span>
          <button
            aria-label={t('fileList.previousSearchMatch')}
            title={`${t('fileList.previousSearchMatch')} (↑)`}
            disabled={searchMatches.length === 0}
            onClick={() => {
              selectSearchMatch(searchMatches, searchMatchPosition - 1);
              searchInputReference.current?.focus();
            }}
            type="button"
          >
            <Icon name="ChevronUp" />
          </button>
          <button
            aria-label={t('fileList.nextSearchMatch')}
            title={`${t('fileList.nextSearchMatch')} (↓)`}
            disabled={searchMatches.length === 0}
            onClick={() => {
              selectSearchMatch(searchMatches, searchMatchPosition + 1);
              searchInputReference.current?.focus();
            }}
            type="button"
          >
            <Icon name="ChevronDown" />
          </button>
          <button aria-label={t('fileList.closeSearch')} onClick={closeSearch} type="button">
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
};
