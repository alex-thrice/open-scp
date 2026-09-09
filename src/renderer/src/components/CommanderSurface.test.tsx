import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandButtons, type FileCommand } from './CommanderSurface';

describe('CommandButtons', () => {
  it('uses distinct icons for editing and renaming files', () => {
    const commands: FileCommand[] = [
      { id: 'edit', label: 'Edit', run: vi.fn() },
      { id: 'rename', label: 'Rename', run: vi.fn() },
    ];

    render(<CommandButtons commands={commands} />);

    expect(
      screen.getByRole('button', { name: 'Edit' }).querySelector('svg')?.getAttribute('data-icon'),
    ).toBe('Pencil');
    expect(
      screen
        .getByRole('button', { name: 'Rename' })
        .querySelector('svg')
        ?.getAttribute('data-icon'),
    ).toBe('TextCursorInput');
  });
});
