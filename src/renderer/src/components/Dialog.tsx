import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export type ModalResult = 'ok' | 'cancel';

export const Dialog = ({
  title,
  onClose,
  children,
  footer,
  notice,
  initialFocus,
  className,
}: {
  readonly title: string;
  readonly onClose: (result: ModalResult) => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly notice?: ReactNode;
  readonly initialFocus?: string;
  readonly className?: string;
}) => {
  const reference = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = reference.current;
    dialog?.showModal();
    if (!dialog) return;
    dialog.returnValue = 'cancel';
    let focused = false;
    const focus = () => {
      if (focused) return;
      const candidates = dialog.querySelectorAll<HTMLElement>(
        initialFocus ??
          '[data-dialog-autofocus], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [data-dialog-result="ok"], button[type="submit"], .dialog-actions .primary, .dialog-actions .destructive',
      );
      const target = [...candidates].find(
        (element) => !element.closest('[hidden], details:not([open])'),
      );
      if (!target || target.matches(':disabled')) return;
      target.focus();
      focused = document.activeElement === target;
    };
    focus();
    const observer = new MutationObserver(focus);
    observer.observe(dialog, { subtree: true, attributes: true, childList: true });
    return () => {
      observer.disconnect();
      dialog.close(dialog.returnValue);
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocus]);
  const finish = (result: ModalResult) => {
    if (reference.current) reference.current.returnValue = result;
    onClose(result);
  };
  return (
    <dialog
      ref={reference}
      className={`connection-dialog native-dialog${className ? ` ${className}` : ''}`}
      aria-label={title}
      onClick={(event) => {
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
          '[data-dialog-result]',
        );
        if (!target || target.closest('dialog') !== reference.current || target.disabled) return;
        const result = target.dataset.dialogResult;
        if (result === 'ok' || result === 'cancel') {
          event.preventDefault();
          finish(result);
        }
      }}
      onSubmitCapture={() => {
        if (reference.current) reference.current.returnValue = 'ok';
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          event.key !== 'Enter' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          target.closest('dialog') !== reference.current ||
          target.closest('button, textarea, select, a, summary, [contenteditable="true"]')
        )
          return;
        const confirm = reference.current?.querySelector<HTMLButtonElement>(
          '[data-dialog-result="ok"], button[type="submit"], .dialog-actions .primary, .dialog-actions .destructive',
        );
        if (confirm && !confirm.disabled) {
          event.preventDefault();
          confirm.click();
        }
      }}
      onInvalidCapture={(event) => {
        event.preventDefault();
        setInvalid(true);
      }}
      onInputCapture={() => setInvalid(false)}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        finish('cancel');
      }}
    >
      <header className="dialog-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label={t('library.close')}
          title={t('library.close')}
          onClick={() => finish('cancel')}
        >
          <Icon name="X" />
        </button>
      </header>
      <div className="dialog-body">
        {invalid ? <p role="alert">{t('library.validation')}</p> : null}
        {children}
      </div>
      {notice ? <div className="dialog-notice">{notice}</div> : null}
      {footer ? <div className="dialog-actions dialog-footer">{footer}</div> : null}
    </dialog>
  );
};
