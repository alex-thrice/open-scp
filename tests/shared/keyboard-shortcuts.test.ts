// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  defaultKeyboardShortcuts,
  formatShortcut,
  keyboardShortcutsSchema,
  matchesShortcut,
  shortcutFromKeyboardEvent,
} from '../../src/shared/models/keyboard-shortcuts';

describe('keyboard shortcuts', () => {
  it('treats Ctrl and Command as the portable primary modifier', () => {
    const shortcut = { key: 'T', primary: true, alt: false, shift: false };
    expect(
      matchesShortcut(
        { key: 't', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
        shortcut,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: 'T', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false },
        shortcut,
      ),
    ).toBe(true);
    expect(formatShortcut(shortcut, true)).toBe('⌘+T');
  });

  it('captures safe combinations and rejects bare printable keys', () => {
    expect(
      shortcutFromKeyboardEvent({
        key: 'n',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toEqual({ key: 'N', primary: true, alt: false, shift: true });
    expect(
      shortcutFromKeyboardEvent({
        key: 'n',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeUndefined();
  });

  it('rejects duplicate assignments in persisted settings', () => {
    expect(
      keyboardShortcutsSchema.safeParse({
        ...defaultKeyboardShortcuts,
        closeWorkspace: defaultKeyboardShortcuts.newWorkspace,
      }).success,
    ).toBe(false);
  });
});
