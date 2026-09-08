// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createApplicationMenuTemplate,
  type ApplicationMenuActions,
} from '../../src/main/application-menu';

const actions = (): ApplicationMenuActions => ({
  openAbout: vi.fn(),
  openRepository: vi.fn(),
  sendCommand: vi.fn(),
});

describe('application menu', () => {
  it('provides the conventional Windows sections and an About command', () => {
    const template = createApplicationMenuTemplate('en', 'win32', actions());

    expect(template.map((item) => item.label)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    const help = template.find((item) => item.label === 'Help');
    expect(Array.isArray(help?.submenu) ? help.submenu.map((item) => item.label) : []).toContain(
      'About OpenSCP',
    );
  });

  it('places About OpenSCP in the macOS application menu', () => {
    const template = createApplicationMenuTemplate('ru', 'darwin', actions());
    const application = template[0];

    expect(application?.label).toBe('OpenSCP');
    expect(
      Array.isArray(application?.submenu)
        ? application.submenu.map((item) => item.label).filter(Boolean)
        : [],
    ).toContain('О программе OpenSCP');
  });
});
