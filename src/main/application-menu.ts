import { Menu, type MenuItemConstructorOptions } from 'electron';
import { menuResources } from '@shared/localization/menu-resources';
import type { ApplicationMenuCommand } from '@shared/ipc/contracts';

export interface ApplicationMenuActions {
  readonly openAbout: (language: 'en' | 'ru') => void;
  readonly openRepository: () => void;
  readonly sendCommand: (command: ApplicationMenuCommand) => void;
}

export const createApplicationMenuTemplate = (
  language: 'en' | 'ru',
  platform: NodeJS.Platform,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] => {
  const labels = menuResources[language];
  const applicationMenu: MenuItemConstructorOptions[] =
    platform === 'darwin'
      ? [
          {
            label: 'OpenSCP',
            submenu: [
              { label: labels.about, click: () => actions.openAbout(language) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: labels.quit },
            ],
          },
        ]
      : [];
  const fileMenu: MenuItemConstructorOptions[] = [
    {
      label: labels.newWorkspace,
      click: () => actions.sendCommand('new-workspace'),
    },
    {
      label: labels.connections,
      click: () => actions.sendCommand('connections'),
    },
    {
      label: labels.settings,
      click: () => actions.sendCommand('settings'),
    },
    { type: 'separator' },
    {
      label: labels.closeWorkspace,
      click: () => actions.sendCommand('close-workspace'),
    },
  ];
  if (platform !== 'darwin') {
    fileMenu.push({ type: 'separator' }, { role: 'quit', label: labels.quit });
  }
  const helpMenu: MenuItemConstructorOptions[] = [
    { label: labels.repository, click: actions.openRepository },
  ];
  if (platform !== 'darwin') {
    helpMenu.push(
      { type: 'separator' },
      { label: labels.about, click: () => actions.openAbout(language) },
    );
  }

  return [
    ...applicationMenu,
    { label: labels.file, submenu: fileMenu },
    {
      label: labels.view,
      submenu: [
        { role: 'resetZoom', label: labels.resetZoom },
        { role: 'zoomIn', label: labels.zoomIn },
        { role: 'zoomOut', label: labels.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: labels.togglefullscreen },
      ],
    },
    {
      label: labels.window,
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: labels.minimize },
        { role: 'zoom', label: labels.zoomWindow },
        ...(platform === 'darwin'
          ? ([{ type: 'separator' }, { role: 'front', label: labels.bringAllToFront }] as const)
          : []),
      ],
    },
    { label: labels.help, role: 'help', submenu: helpMenu },
  ];
};

export const setApplicationLanguage = (
  language: 'en' | 'ru',
  actions: ApplicationMenuActions,
): void => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(createApplicationMenuTemplate(language, process.platform, actions)),
  );
};
