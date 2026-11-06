import {
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from 'electron';
import { menuResources } from '@shared/localization/menu-resources';

const textControls: readonly ContextMenuParams['formControlType'][] = [
  'input-email',
  'input-number',
  'input-password',
  'input-search',
  'input-telephone',
  'input-text',
  'input-url',
  'text-area',
];

export const createTextInputMenuTemplate = (
  language: 'en' | 'ru',
  params: Pick<ContextMenuParams, 'isEditable' | 'formControlType' | 'editFlags'>,
): MenuItemConstructorOptions[] => {
  if (!params.isEditable && !textControls.includes(params.formControlType)) return [];
  const labels = menuResources[language];
  return [
    { role: 'cut', label: labels.cut, enabled: params.editFlags.canCut },
    { role: 'copy', label: labels.copy, enabled: params.editFlags.canCopy },
    { role: 'paste', label: labels.paste, enabled: params.editFlags.canPaste },
  ];
};

export const configureTextInputContextMenu = (
  window: BrowserWindow,
  getLanguage: () => 'en' | 'ru',
): void => {
  window.webContents.on('context-menu', (_event, params) => {
    const template = createTextInputMenuTemplate(getLanguage(), params);
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({
      window,
      ...(params.frame ? { frame: params.frame } : {}),
    });
  });
};
