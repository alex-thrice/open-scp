import { z } from 'zod';

export const shortcutActionSchema = z.enum([
  'newWorkspace',
  'closeWorkspace',
  'switchPanel',
  'createDirectory',
  'copy',
  'refresh',
  'rename',
  'delete',
  'edit',
  'parentDirectory',
]);
export type ShortcutAction = z.infer<typeof shortcutActionSchema>;

export const keyboardShortcutSchema = z
  .strictObject({
    key: z.string().min(1).max(32),
    primary: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  })
  .refine(
    (value) =>
      !['alt', 'control', 'meta', 'shift'].includes(value.key.toLowerCase()) &&
      (value.key.length !== 1 || value.primary || value.alt),
  );
export type KeyboardShortcut = z.infer<typeof keyboardShortcutSchema>;

export const keyboardShortcutsSchema = z
  .strictObject({
    newWorkspace: keyboardShortcutSchema,
    closeWorkspace: keyboardShortcutSchema,
    switchPanel: keyboardShortcutSchema,
    createDirectory: keyboardShortcutSchema,
    copy: keyboardShortcutSchema,
    refresh: keyboardShortcutSchema,
    rename: keyboardShortcutSchema,
    delete: keyboardShortcutSchema,
    edit: keyboardShortcutSchema,
    parentDirectory: keyboardShortcutSchema,
  })
  .refine((shortcuts) => {
    const identities = Object.values(shortcuts).map(
      (value) => `${value.primary}:${value.alt}:${value.shift}:${value.key.toLowerCase()}`,
    );
    return new Set(identities).size === identities.length;
  });
export type KeyboardShortcuts = z.infer<typeof keyboardShortcutsSchema>;

const shortcut = (key: string, primary = false, alt = false, shift = false): KeyboardShortcut => ({
  key,
  primary,
  alt,
  shift,
});

export const defaultKeyboardShortcuts: KeyboardShortcuts = {
  newWorkspace: shortcut('T', true),
  closeWorkspace: shortcut('W', true),
  switchPanel: shortcut('F6'),
  createDirectory: shortcut('F7'),
  copy: shortcut('F5'),
  refresh: shortcut('F5', true),
  rename: shortcut('F2'),
  delete: shortcut('Delete'),
  edit: shortcut('F4'),
  parentDirectory: shortcut('Backspace'),
};

interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const normalizeKey = (key: string): string => {
  if (key === ' ') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
};

export const shortcutFromKeyboardEvent = (
  event: KeyboardEventLike,
): KeyboardShortcut | undefined => {
  if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return undefined;
  const key = normalizeKey(event.key);
  const primary = event.ctrlKey || event.metaKey;
  if (key.length === 1 && !primary && !event.altKey) return undefined;
  return shortcut(key, primary, event.altKey, event.shiftKey);
};

export const matchesShortcut = (event: KeyboardEventLike, value: KeyboardShortcut): boolean =>
  normalizeKey(event.key) === normalizeKey(value.key) &&
  (event.ctrlKey || event.metaKey) === value.primary &&
  event.altKey === value.alt &&
  event.shiftKey === value.shift;

export const formatShortcut = (value: KeyboardShortcut, isMac = false): string =>
  [
    value.primary ? (isMac ? '⌘' : 'Ctrl') : undefined,
    value.alt ? (isMac ? '⌥' : 'Alt') : undefined,
    value.shift ? (isMac ? '⇧' : 'Shift') : undefined,
    value.key,
  ]
    .filter(Boolean)
    .join('+');

export const sameShortcut = (left: KeyboardShortcut, right: KeyboardShortcut): boolean =>
  left.key.toLowerCase() === right.key.toLowerCase() &&
  left.primary === right.primary &&
  left.alt === right.alt &&
  left.shift === right.shift;
