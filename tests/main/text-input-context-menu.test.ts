// @vitest-environment node
import type { ContextMenuParams } from 'electron';
import { describe, expect, it } from 'vitest';
import { createTextInputMenuTemplate } from '../../src/main/text-input-context-menu';

const flags = (
  overrides: Partial<ContextMenuParams['editFlags']> = {},
): ContextMenuParams['editFlags'] => ({
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
  ...overrides,
});

describe('text input context menu', () => {
  it('offers exactly Cut, Copy and Paste with native availability and localized labels', () => {
    expect(
      createTextInputMenuTemplate('ru', {
        isEditable: true,
        formControlType: 'input-text',
        editFlags: flags({ canCut: true, canCopy: true }),
      }),
    ).toEqual([
      { role: 'cut', label: 'Вырезать', enabled: true },
      { role: 'copy', label: 'Копировать', enabled: true },
      { role: 'paste', label: 'Вставить', enabled: false },
    ]);
  });

  it('allows copying read-only text while preserving native restrictions on masked passwords', () => {
    for (const [formControlType, isEditable, editFlags] of [
      ['input-text', false, flags({ canCopy: true })],
      ['input-password', true, flags({ canPaste: true })],
    ] as const) {
      const menu = createTextInputMenuTemplate('en', { formControlType, isEditable, editFlags });
      expect(menu.map((item) => item.enabled)).toEqual([
        editFlags.canCut,
        editFlags.canCopy,
        editFlags.canPaste,
      ]);
    }
  });

  it('does not replace file menus or add a menu to non-text controls', () => {
    for (const formControlType of ['none', 'input-checkbox', 'select-one'] as const) {
      expect(
        createTextInputMenuTemplate('en', {
          isEditable: false,
          formControlType,
          editFlags: flags(),
        }),
      ).toEqual([]);
    }
  });
});
