import { expect, type Page, type Locator } from '@playwright/test';

export const expectSourceIndicatorAtEnd = async (panel: Locator) => {
  const trigger = panel.getByRole('button', { name: 'Drive or connection' });
  const geometry = await trigger.evaluate((element) => {
    const indicator = element.querySelector(':scope > svg');
    if (!indicator) throw new Error('No source indicator.');
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) throw new Error('No source indicator styles.');
    return {
      inset: element.getBoundingClientRect().right - indicator.getBoundingClientRect().right,
      expectedInset: parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth),
      indicatorWidth: indicator.getBoundingClientRect().width,
    };
  });
  expect(geometry.inset).toBeCloseTo(geometry.expectedInset, 1);
  expect(geometry.indicatorWidth).toBe(14);
};

export const newConnection = async (page: Page, kind: 'sftp' | 's3') => {
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Connections', exact: true });
  await form.getByLabel('Connection type').selectOption(kind);
  if (kind === 'sftp') {
    await form.getByLabel('Authentication').selectOption('password');
    await form.getByText('Advanced', { exact: true }).click();
  }
  return form;
};

export const finishProfile = async (page: Page, form: Locator) => {
  await form.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(form.getByText('Saved profiles', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

export const openConnection = async (page: Page, side: 'left' | 'right', name: string) => {
  const panel = page.getByRole('tabpanel').getByTestId(side + '-panel');
  await panel.getByRole('button', { name: 'Drive or connection' }).click();
  await page.getByRole('combobox', { name: 'Search by name…' }).fill(name);
  await page.getByRole('option').filter({ hasText: name }).click();
};

export const copySelection = async (page: Page, panel: Locator) => {
  await panel.getByRole('button', { name: /^Copy to /u }).click();
  await page
    .getByRole('dialog', { name: 'Copy', exact: true })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
};

export const setLanguage = async (page: Page, language: 'ru' | 'en') => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption(language);
  await page
    .getByRole('button', { name: language === 'ru' ? 'Готово' : 'Done', exact: true })
    .click();
};
