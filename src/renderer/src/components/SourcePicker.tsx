import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LocalDrive } from '@shared/ipc/contracts';
import type { WorkspaceSnapshot } from '@shared/ipc/workspace';
import { Icon } from './Icon';
import { protocolIcon } from './workspace-layout';

interface SourceItem {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly kind: 'local' | 'sftp' | 's3';
  readonly image: string | undefined;
}

export const SourcePicker = ({
  snapshot,
  session,
  rootPath,
  isActive,
  isConnecting,
  onNavigate,
  onConnect,
}: {
  readonly snapshot: WorkspaceSnapshot;
  readonly session: WorkspaceSnapshot['sessions'][number] | undefined;
  readonly rootPath: string | undefined;
  readonly isActive: boolean;
  readonly isConnecting: boolean;
  readonly onNavigate: (path: string) => void;
  readonly onConnect: (profileId: string) => void;
}) => {
  const { t } = useTranslation();
  const id = useId();
  const [drives, setDrives] = useState<readonly LocalDrive[]>([]);
  const [driveError, setDriveError] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isActive) return;
    let live = true;
    void window.desktop.listLocalDrives().then((result) => {
      if (!live) return;
      setDriveError(!result.ok);
      if (result.ok) setDrives(result.data);
    });
    return () => {
      live = false;
    };
  }, [isActive, open]);
  useEffect(() => {
    if (!isActive || session || isConnecting) setOpen(false);
  }, [isActive, session, isConnecting]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const drive = drives.find(
    (item) => item.path.toLocaleLowerCase() === rootPath?.toLocaleLowerCase(),
  );
  const includes = (name: string) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const folders = [
    ...new Set(
      [...(snapshot.profileFolders ?? []), ...Object.values(snapshot.profileGroups ?? {})].filter(
        Boolean,
      ),
    ),
    '',
  ];
  const groups: { name: string; items: SourceItem[] }[] = [
    {
      name: t('ui.computer'),
      items: drives
        .filter((item) => includes(item.label))
        .map((item) => ({
          id: item.path,
          name: item.label,
          detail: item.path,
          kind: 'local' as const,
          image: item.icon,
        })),
    },
    ...folders.map((folder) => ({
      name: folder || t('ui.ungrouped'),
      items: snapshot.profiles
        .filter(
          (item) => (snapshot.profileGroups?.[item.id] ?? '') === folder && includes(item.name),
        )
        .map((item) => ({
          id: item.id,
          name: item.name,
          detail: item.kind === 'sftp' ? item.host : item.bucket || item.endpoint || item.region,
          kind: item.kind,
          image: undefined,
        })),
    })),
  ].filter((group) => group.items.length);
  const items = groups.flatMap((group) => group.items);
  const select = (index: number) => {
    const item = items[index];
    if (!item) return;
    setOpen(false);
    if (item.kind === 'local') {
      onNavigate(snapshot.localPathHistory?.[item.id] ?? item.id);
      trigger.current?.focus();
    } else onConnect(item.id);
  };
  useEffect(() => {
    popup.current
      ?.querySelector(`[data-option-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <div className="source-picker">
      <button
        ref={trigger}
        className="source-trigger"
        type="button"
        disabled={!!session || isConnecting}
        aria-label={t('ui.source')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        title={session ? t('ui.locked') : rootPath}
        onClick={() => {
          const bounds = trigger.current?.getBoundingClientRect();
          if (bounds) {
            const height = Math.min(430, Math.max(160, window.innerHeight - bounds.bottom - 18));
            setPosition({
              left: Math.max(8, Math.min(bounds.left, window.innerWidth - 380)),
              top: Math.max(8, Math.min(bounds.bottom + 5, window.innerHeight - height - 8)),
              maxHeight: height,
            });
          }
          setQuery('');
          setActive(0);
          setOpen(!open);
        }}
      >
        <span className="source-icon" data-kind={session?.kind ?? 'local'}>
          {!session && drive?.icon ? (
            <img src={drive.icon} alt="" />
          ) : (
            <Icon name={protocolIcon(session?.kind ?? 'local')} />
          )}
        </span>
        <span className="source-label">
          {session?.name ?? drive?.label ?? rootPath ?? t('ui.computer')}
        </span>
        <Icon name={session ? 'LockKeyhole' : 'ChevronDown'} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popup}
              id={id}
              className="source-menu"
              role="dialog"
              aria-label={t('ui.source')}
              style={position}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  trigger.current?.focus();
                }
                if (event.key === 'Tab') {
                  setOpen(false);
                  trigger.current?.focus();
                }
                if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) {
                  event.preventDefault();
                  setActive(
                    (current) =>
                      (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                      items.length,
                  );
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  select(active);
                }
              }}
            >
              <label className="source-search">
                <Icon name="Search" />
                <input
                  ref={search}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={`${id}-list`}
                  aria-activedescendant={items[active] ? `${id}-${active}` : undefined}
                  aria-label={t('ui.sourceSearch')}
                  placeholder={t('ui.sourceSearch')}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setActive(0);
                  }}
                />
              </label>
              <div
                className="source-options"
                id={`${id}-list`}
                role="listbox"
                aria-label={t('ui.source')}
              >
                {groups.map((group, groupIndex) => (
                  <div
                    role="group"
                    aria-labelledby={`${id}-group-${groupIndex}`}
                    key={group.name + groupIndex}
                  >
                    <div className="source-group-title" id={`${id}-group-${groupIndex}`}>
                      <Icon
                        name={
                          groupIndex === 0 && group.items[0]?.kind === 'local'
                            ? 'Monitor'
                            : 'Folder'
                        }
                      />
                      {group.name}
                    </div>
                    {group.items.map((item) => {
                      const index = items.indexOf(item);
                      return (
                        <button
                          type="button"
                          tabIndex={-1}
                          role="option"
                          aria-selected={item.kind === 'local' && item.id === rootPath}
                          data-active={index === active}
                          data-option-index={index}
                          id={`${id}-${index}`}
                          className="source-option"
                          key={item.id}
                          onMouseMove={() => setActive(index)}
                          onClick={() => select(index)}
                        >
                          <span className="source-icon" data-kind={item.kind}>
                            {item.image ? (
                              <img src={item.image} alt="" />
                            ) : (
                              <Icon name={protocolIcon(item.kind)} />
                            )}
                          </span>
                          <span className="source-option-name">
                            {item.name}
                            <small>{item.detail}</small>
                          </span>
                          <span className="protocol-label">
                            {item.kind === 'local' ? t('ui.local') : item.kind.toUpperCase()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {!items.length ? (
                  <p className="source-empty" role="status">
                    {t('ui.noResults')}
                  </p>
                ) : null}
                {driveError ? <p className="inline-error">{t('drives.error')}</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
