import { useState, type ReactNode, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './Icon';
import {
  formatShortcut,
  matchesShortcut,
  type KeyboardShortcut,
} from '@shared/models/keyboard-shortcuts';

const commandIcons: Record<string, IconName> = {
  mkdir: 'FolderPlus',
  createFile: 'FileText',
  copy: 'Copy',
  download: 'Copy',
  edit: 'Pencil',
  rename: 'TextCursorInput',
  delete: 'Trash2',
  terminal: 'SquareTerminal',
  externalDrag: 'FileOutput',
};

export interface FileCommand {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: KeyboardShortcut;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export const fileCommandShortcut = (command: FileCommand): string | undefined =>
  command.shortcut ? formatShortcut(command.shortcut, /Mac/iu.test(navigator.platform)) : undefined;

export const CommandButtons = ({ commands }: { readonly commands: readonly FileCommand[] }) => (
  <div className="remote-controls command-bar">
    {commands
      .filter((command) => !['refresh', 'up'].includes(command.id))
      .map((command) => (
        <button
          aria-label={command.label}
          key={command.id}
          disabled={command.disabled}
          onClick={command.run}
          title={
            fileCommandShortcut(command)
              ? `${command.label} (${fileCommandShortcut(command)})`
              : command.label
          }
          className={`icon-button command-${command.id}`}
        >
          <Icon name={commandIcons[command.id] ?? 'Copy'} />
        </button>
      ))}
  </div>
);

export const CommanderSurface = ({
  commands,
  children,
  onDrop,
}: {
  readonly commands: readonly FileCommand[];
  readonly children: ReactNode;
  readonly onDrop?: ((event: DragEvent<HTMLDivElement>) => void) | undefined;
}) => {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, select, textarea, dialog, [role="dialog"]'))
      return;
    const command = commands.find((item) => item.shortcut && matchesShortcut(event, item.shortcut));
    if (command) {
      event.preventDefault();
      event.stopPropagation();
      if (!command.disabled) command.run();
    }
    if (event.key === 'Escape') setMenu(null);
  };
  return (
    <div
      className="commander-surface"
      tabIndex={-1}
      onKeyDown={keyDown}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea, dialog, [role="dialog"]'))
          return;
        event.preventDefault();
        setMenu({
          x: Math.min(event.clientX, window.innerWidth - 300),
          y: Math.min(event.clientY, window.innerHeight - 330),
        });
      }}
      onDragOver={
        onDrop
          ? (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          : undefined
      }
      onDrop={onDrop}
    >
      {children}
      {menu ? (
        <div
          className="context-menu"
          role="menu"
          aria-label={t('commander.menu')}
          style={{ left: menu.x, top: menu.y }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null);
          }}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus();
          }}
        >
          {commands.map((command, index) => (
            <button
              autoFocus={index === 0}
              role="menuitem"
              key={command.id}
              disabled={command.disabled}
              onClick={() => {
                setMenu(null);
                command.run();
              }}
            >
              {command.label} <kbd>{fileCommandShortcut(command)}</kbd>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
