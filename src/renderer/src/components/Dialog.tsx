import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export const Dialog = ({
  title,
  onClose,
  children,
  footer,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) => {
  const reference = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = reference.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={reference}
      className="connection-dialog native-dialog"
      aria-label={title}
      onInvalidCapture={(event) => {
        event.preventDefault();
        setInvalid(true);
      }}
      onInputCapture={() => setInvalid(false)}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label={t('library.close')}
          title={t('library.close')}
          onClick={onClose}
        >
          <Icon name="X" />
        </button>
      </header>
      <div className="dialog-body">
        {invalid ? <p role="alert">{t('library.validation')}</p> : null}
        {children}
      </div>
      {footer ? <div className="dialog-actions dialog-footer">{footer}</div> : null}
    </dialog>
  );
};
