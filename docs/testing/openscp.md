# OpenSCP: переименование, лицензия и CI

Проверка 2026-09-04. `origin` — `https://github.com/alex-thrice/open-scp.git`.
Имя интерфейса/приложения — OpenSCP; технические имена — `openscp`, переменные — `OPENSCP_`.

| Проверка                                                    | Результат                                            |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| Frozen lockfile, pnpm 11.24.0                               | Успешно, версии зависимостей сохранены               |
| ESLint / Prettier / TypeScript / production build           | Успешно на Windows                                   |
| Windows unit                                                | 116 passed, 1 POSIX-only skip                        |
| Packaging contracts                                         | 5 passed                                             |
| OpenSSH + MinIO integration                                 | 31 passed                                            |
| Windows Electron UI, включая packaged smoke и оба протокола | 7 passed, 1 Linux-only skip                          |
| Runtime license review                                      | 41 dependency, без непокрытых пакетов в Windows ASAR |
| GitHub Actions syntax/expressions                           | Три workflow проверены actionlint 1.7.11             |

Windows-проверки используют Node.js 24.19.0 (допустим `engines`), pnpm 11.24.0,
Electron 44.0.0. Linux Docker build и GitHub CI используют Node.js 24.20.0 из `.nvmrc`.

Windows NSIS и portable собраны. Установка NSIS в отдельный временный каталог,
packaged smoke с SFTP/S3 и последующее удаление тестовой установки прошли успешно.
Authenticode обоих файлов — `NotSigned`.

Linux DEB и AppImage собраны из финальных исходников в Debian 12 / Docker Desktop.
Для каждого пакета прошли оба smoke-теста: secure storage/перезапуск/SFTP/S3/лицензии
и отказ реального `basic_text` backend. DEB успешно установлен и удалён;
AppImage проверен через extract/AppRun. Linux unit: **115 passed, 2 Windows-only skips**.
Контейнер использует non-root, Xvfb и отдельный GNOME Keyring; его тестовый
`--no-sandbox` не добавлен в desktop launcher и не подтверждает native Linux sandbox.

Артефакты:

- `release/openscp-0.2.0-win-x64-setup.exe`
- `release/openscp-0.2.0-win-x64-portable.exe`
- `release/linux-container/openscp-0.2.0-linux-amd64.deb`
- `release/linux-container/openscp-0.2.0-linux-x86_64.AppImage`

UI smoke проверяет имя процесса Electron, заголовок, файловые операции, SFTP/S3 transfers,
шифрование credentials, перезапуск и наличие MIT/сторонних уведомлений в packaged resources.
Все сетевые credentials фиктивные; OpenSSH/MinIO работают только на localhost.

Dev-приложение и пакеты сообщают имя OpenSCP. Конфигурация electron-builder загружается
однократно; перед упаковкой создаются уведомления зависимостей и при необходимости
загружается runtime Electron 44 для копирования Chromium notices.

## Ограничения

Здесь приведены результаты локальной проверки. Результаты hosted GitHub Actions доступны
в [разделе Actions](https://github.com/alex-thrice/open-scp/actions).
macOS-сборка и native smoke настроены в CI, но локально не проверены из-за отсутствия Mac.
Подпись/нотаризация требуют сертификатов владельца; созданные пакеты — development artifacts.
Старые локальные бинарники не переименовывались, их прежние хеши не относятся к OpenSCP.
