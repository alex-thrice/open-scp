import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PasswordInput } from './PasswordInput';

describe('PasswordInput', () => {
  it('preserves the value, selection and focus when revealing and hiding without submitting', () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form aria-label="Connection" onSubmit={submit}>
        <label htmlFor="secret">Password</label>
        <PasswordInput id="secret" name="secret" defaultValue="typed-secret" />
      </form>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Password');
    expect(input.type).toBe('password');
    input.focus();
    input.setSelectionRange(2, 7, 'backward');

    fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
    expect(input.type).toBe('text');
    expect(input.value).toBe('typed-secret');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      2,
      7,
      'backward',
    ]);
    expect(screen.getByRole('button', { name: 'Hide value' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(input.type).toBe('password');
    expect(new FormData(screen.getByRole<HTMLFormElement>('form')).get('secret')).toBe(
      'typed-secret',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('hides the value on submit, reset and clearing the input', () => {
    render(
      <form aria-label="Connection" onSubmit={(event) => event.preventDefault()}>
        <PasswordInput aria-label="Password" defaultValue="typed-secret" />
      </form>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Password');
    const form = screen.getByRole<HTMLFormElement>('form');
    const show = () => fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
    show();
    fireEvent.submit(form);
    expect(input.type).toBe('password');
    show();
    fireEvent.reset(form);
    expect(input.type).toBe('password');
    show();
    fireEvent.input(input, { target: { value: '' } });
    expect(input.type).toBe('password');
  });

  it('keeps disabled values masked when the field is enabled again', () => {
    const { rerender } = render(<PasswordInput aria-label="Password" />);
    const input = screen.getByLabelText<HTMLInputElement>('Password');
    fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
    rerender(<PasswordInput aria-label="Password" disabled />);
    expect(input.type).toBe('password');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Show value' }).disabled).toBe(
      true,
    );
    rerender(<PasswordInput aria-label="Password" />);
    expect(input.type).toBe('password');
  });
});
