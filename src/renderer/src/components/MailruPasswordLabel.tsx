import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const MailruPasswordLabel = ({ inputId }: { readonly inputId: string }) => {
  const { t } = useTranslation();
  const hintId = useId();
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const close = () => {
    setIsOpen(false);
    setIsPinned(false);
  };

  useLayoutEffect(() => {
    const content = hint.current;
    const button = trigger.current;
    if (!isOpen || !content || !button) return;
    content.showPopover();
    const position = () => {
      const bounds = button.getBoundingClientRect();
      const left = Math.max(
        12,
        Math.min(bounds.left, window.innerWidth - content.offsetWidth - 12),
      );
      const top =
        bounds.bottom + content.offsetHeight <= window.innerHeight - 12
          ? bounds.bottom
          : Math.max(12, bounds.top - content.offsetHeight);
      content.style.left = `${left}px`;
      content.style.top = `${top}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      content.hidePopover();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [isOpen]);

  return (
    <div className="field-label-with-hint">
      <label htmlFor={inputId}>{t('mailru.appPassword')}</label>
      <span
        ref={wrapper}
        className="field-hint"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => {
          if (!isPinned) setIsOpen(false);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <button
          ref={trigger}
          type="button"
          className="field-hint-trigger"
          aria-label={t('mailru.passwordHelp')}
          aria-expanded={isOpen}
          aria-describedby={isOpen ? hintId : undefined}
          onFocus={() => setIsOpen(true)}
          onClick={() => {
            setIsPinned(!isPinned);
            setIsOpen(!isPinned);
          }}
        >
          <span aria-hidden="true">*</span>
        </button>
        <span ref={hint} id={hintId} role="tooltip" popover="manual" className="field-hint-content">
          <span>{t('mailru.passwordHint')}</span>
          <span>{t('mailru.vkIdHint')}</span>
        </span>
      </span>
    </div>
  );
};
