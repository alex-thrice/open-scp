import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { _electron as electron, expect } from '@playwright/test';

const recordVideo = process.argv.includes('--video');
const requestedLanguage = process.argv
  .find((argument) => argument.startsWith('--language='))
  ?.split('=')[1];
assert.ok(
  !requestedLanguage || ['en', 'ru'].includes(requestedLanguage),
  'Use --language=en or --language=ru.',
);
const images = resolve('docs/images');
const videos = resolve('test-results/documentation-media');
const temporaryRoot = resolve('test-results/documentation-data');
const size = { width: 1440, height: 900 };
await mkdir(images, { recursive: true });
await mkdir(videos, { recursive: true });
await mkdir(temporaryRoot, { recursive: true });

const words = {
  en: {
    settings: 'Settings',
    light: 'Light',
    dark: 'Dark',
    done: 'Done',
    language: 'Language',
    connections: 'Connections',
    close: 'Close',
    import: 'Import profiles',
    contents: 'File contents',
    reviewed: 'Import reviewed contents',
    search: 'Search profiles',
  },
  ru: {
    settings: 'Настройки',
    light: 'Светлая',
    dark: 'Тёмная',
    done: 'Готово',
    language: 'Язык',
    connections: 'Подключения',
    close: 'Закрыть',
    import: 'Импорт профилей',
    contents: 'Содержимое файла',
    reviewed: 'Импортировать проверенное содержимое',
    search: 'Поиск профилей',
  },
};

const archive = JSON.stringify({
  version: 1,
  profiles: ['Demo server', 'Web hosting', 'Backup server'].map((name, index) => ({
    kind: 'sftp',
    group: index === 2 ? 'Backups' : 'Servers',
    profile: {
      id: null,
      name,
      host: ['demo.example.com', 'web.example.com', 'backup.example.com'][index],
      port: 22,
      username: 'demo',
      authMode: 'password',
      privateKeyPath: '',
      initialDirectory: '/',
      timeout: 20000,
      keepalive: 10000,
    },
  })),
});

async function capture(language, scenario) {
  const session = await mkdtemp(join(temporaryRoot, 'demo-'));
  const root = join(session, 'Demo files');
  const userData = join(session, 'profile');
  const text = words[language];
  let application;
  let video;
  let presentationStarted;
  const pause = async () => {
    if (recordVideo) await setTimeout(2000);
  };
  const screenshot = async (page, name) => {
    await page.screenshot({
      path: join(images, `${name}${language === 'ru' ? '-ru' : ''}.png`),
      animations: 'disabled',
    });
  };
  try {
    await mkdir(join(root, 'Project', 'Documents'), { recursive: true });
    await mkdir(join(root, 'Project', 'Photos'), { recursive: true });
    await mkdir(join(root, 'Backup'), { recursive: true });
    await mkdir(userData);
    await writeFile(join(userData, 'rclone.conf'), '');
    const files = {
      'Read me.txt': 'OpenSCP documentation demo. All files in this folder are synthetic.\n',
      'Meeting notes.md': '# Project meeting\n\nPrepare a demo and copy the project files.\n',
      'Budget.csv': 'Item,Amount\nHosting,25\nStorage,10\n',
      'Website.html': '<!doctype html><title>Example project</title><h1>Example project</h1>\n',
    };
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(root, 'Project', name), contents);
    }
    application = await electron.launch({
      ...(process.platform === 'linux'
        ? { executablePath: createRequire(resolve('package.json'))('electron') }
        : {}),
      args: [
        '--disable-gpu',
        '--in-process-gpu',
        ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
        `--user-data-dir=${userData}`,
        resolve('out/main/index.js'),
      ],
      env: {
        ...process.env,
        OPENSCP_LOCAL_ROOT: root,
        OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
        OPENSCP_RCLONE_PATH: join(session, 'rclone-not-installed'),
        RCLONE_CONFIG: join(userData, 'rclone.conf'),
      },
      ...(recordVideo
        ? { recordVideo: { dir: videos, size, showActions: { cursor: 'pointer' } } }
        : {}),
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }, dimensions) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(dimensions.width, dimensions.height);
    }, size);
    video = page.video();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByLabel('Language', { exact: true }).selectOption(language);
    await page.getByRole('button', { name: /^(Done|Готово)$/u }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    const left = page.getByTestId('left-panel');
    const right = page.getByTestId('right-panel');
    await left.getByRole('row').filter({ hasText: 'Project' }).dblclick();
    await right.getByRole('row').filter({ hasText: 'Backup' }).dblclick();
    if (scenario === 'copy') {
      presentationStarted = Date.now();
      await pause();
      await left.getByRole('row', { name: 'Budget.csv', exact: true }).click();
      await page.keyboard.press('ControlOrMeta+a');
      await pause();
      await page.keyboard.press('F5');
      const copying = page.getByRole('dialog');
      await expect(copying).toBeVisible();
      await screenshot(page, 'copy');
      await pause();
      await copying.getByRole('button', { name: /^(Confirm|Подтвердить)$/u }).click();
      await expect(right.getByRole('row', { name: 'Budget.csv', exact: true })).toBeVisible();
      await expect(right.getByRole('row', { name: 'Website.html', exact: true })).toBeVisible();
      for (const [name, contents] of Object.entries(files)) {
        assert.equal(await readFile(join(root, 'Backup', name), 'utf8'), contents);
      }
      await pause();
      await screenshot(page, 'workspace');
    } else if (scenario === 'connections') {
      await page.getByRole('button', { name: text.connections, exact: true }).click();
      const library = page.getByRole('dialog');
      await library.getByRole('button', { name: text.import, exact: true }).click();
      await library.getByLabel(text.contents).fill(archive);
      await library.getByRole('button', { name: text.reviewed, exact: true }).click();
      await expect(library.locator('.profile-row')).toHaveCount(3);
      presentationStarted = Date.now();
      await pause();
      await screenshot(page, 'connections');
      await library.getByLabel(text.search).fill('Backup');
      await expect(library.locator('.profile-row')).toHaveCount(1);
      await pause();
      await library.getByLabel(text.search).fill('');
      await pause();
      await library.getByRole('button', { name: text.close, exact: true }).last().click();
    } else {
      presentationStarted = Date.now();
      await pause();
      await page.getByRole('button', { name: text.settings, exact: true }).click();
      await pause();
      await page.getByRole('button', { name: text.dark, exact: true }).click();
      await pause();
      await screenshot(page, 'settings');
      await page.getByRole('button', { name: text.done, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await screenshot(page, 'workspace-dark');
      await pause();
    }
    assert.deepEqual(errors, []);
    console.log(`Captured ${language}/${scenario} with synthetic files and an isolated profile.`);
  } finally {
    const presentationSeconds = presentationStarted ? (Date.now() - presentationStarted) / 1000 : 0;
    await application?.close();
    if (video) {
      await video.saveAs(join(videos, `${scenario}-${language}.webm`));
      await video.delete();
      await writeFile(
        join(videos, `${scenario}-${language}.json`),
        JSON.stringify({ language, scenario, presentationSeconds }),
      );
    }
    const sessionPath = relative(temporaryRoot, session);
    assert.ok(sessionPath && !sessionPath.startsWith('..') && !isAbsolute(sessionPath));
    await rm(session, { recursive: true, force: true });
  }
}

for (const language of requestedLanguage ? [requestedLanguage] : ['en', 'ru']) {
  for (const scenario of ['copy', 'connections', 'appearance']) await capture(language, scenario);
}
