import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export const PasswordInput = ({
  id,
  disabled,
  onInput,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'type'>) => {
  const { t } = useTranslation();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef<{
    start: number | null;
    end: number | null;
    direction: 'forward' | 'backward' | 'none' | null;
  } | null>(null);
  const [visible, setVisible] = useState(false);
  const title = t(visible ? 'connections.hideSecret' : 'connections.showSecret');

  useEffect(() => {
    const form = input.current?.form;
    const hide = () => setVisible(false);
    form?.addEventListener('submit', hide);
    form?.addEventListener('reset', hide);
    return () => {
      form?.removeEventListener('submit', hide);
      form?.removeEventListener('reset', hide);
    };
  }, [props.form]);

  useEffect(() => {
    if (disabled) setVisible(false);
  }, [disabled]);

  useLayoutEffect(() => {
    const current = input.current;
    const saved = selection.current;
    if (!current || !saved) return;
    current.focus({ preventScroll: true });
    current.setSelectionRange(saved.start, saved.end, saved.direction ?? undefined);
    selection.current = null;
    // Chromium can reset the selection when it rebuilds the password editor after
    // this commit. Restore it once more before painting, without taking focus back.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === current)
        current.setSelectionRange(saved.start, saved.end, saved.direction ?? undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <span className="password-input">
      <input
        {...props}
        id={inputId}
        ref={input}
        disabled={disabled}
        type={visible && !disabled ? 'text' : 'password'}
        onInput={(event) => {
          if (!event.currentTarget.value) setVisible(false);
          onInput?.(event);
        }}
      />
      <button
        type="button"
        className="password-input__toggle"
        aria-label={title}
        aria-controls={inputId}
        aria-pressed={visible}
        title={title}
        disabled={disabled}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          const current = input.current;
          if (!current) return;
          selection.current = {
            start: current.selectionStart,
            end: current.selectionEnd,
            direction: current.selectionDirection,
          };
          setVisible(!visible);
        }}
      >
        <Icon name={visible ? 'EyeOff' : 'Eye'} />
      </button>
    </span>
  );
};
