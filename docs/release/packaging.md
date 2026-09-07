# Пакеты T19/T20

T18 **намеренно пропущен по указанию владельца**. Эти сборки не означают прохождение
нагрузочных проверок T18 или release readiness T21. Публикации и автоматического updater нет.

## Идентичность и собственные ресурсы

`electron-builder.cjs` и `scripts/package-config.cjs` задают единый контракт упаковки.
Development identity: `com.electron.openscp`, product name `OpenSCP`.
Имя выбрано владельцем; независимый код распространяется под MIT, сайт проекта —
`https://github.com/alex-thrice/open-scp`. Финальный signing bundle ID, издатель и канал
публичных релизов остаются отдельными решениями. `example.invalid` в dev maintainer email —
заведомо несуществующий контакт. Настройки нового имени хранятся отдельно от ранних dev builds.

`pnpm licenses:check` проверяет дерево runtime-зависимостей и создаёт полные уведомления.
`pnpm package` выполняет ту же проверку и включает MIT, THIRD_PARTY_NOTICES и каталог
`licenses/` в resources каждого пакета; уведомления Electron/Chromium также сохраняются.

Геометрия оригинальной иконки находится в `build-resources/icon-shapes.json`. Генератор
`pnpm icons` создаёт PNG (16–1024), ICO, ICNS и SVG без сторонних изображений, шрифтов,
сетевых запросов и материалов WinSCP. Результаты воспроизводимы и генерируются при упаковке.
`ssh2` использует pure-JS crypto: необязательные `cpu-features` и native install script
отключены явно. Pageant helper упаковывается вне ASAR для запуска Windows.

## Локальная development-сборка

Требуются Node 24.20.0, pnpm 11.24.0 и `pnpm install --frozen-lockfile`.

```text
pnpm package:win       # native Windows x64: NSIS setup + portable
pnpm package:linux     # Linux x64: AppImage + DEB
pnpm package:mac       # Apple Silicon: DMG + ZIP, ad-hoc, НЕ notarized
pnpm test:packaging    # контракты конфигурации и генератор иконок
```

`pnpm package` выбирает текущую платформу. Имена выходных файлов содержат версию и
архитектуру; для DEB это `amd64`, для AppImage — `x86_64`. macOS нужно собирать на
arm64 Mac. Подпись требует родной ОС. В dev-режиме ambient CSC credentials не используются.
macOS ad-hoc signature нужна для тестов, но не даёт доверия Gatekeeper и не заменяет Developer ID.

NSIS ставит приложение per-user, не требует elevation, не запускает его автоматически после
установки и сохраняет настройки при uninstall. Portable переносит только программу:
DPAPI-секреты не становятся переносимыми между пользователями/машинами.

Linux DEB устанавливает `/opt/OpenSCP`, launcher `/usr/bin/openscp` и desktop entry.
Установщик не добавляет setuid-бинарник, не отключает sandbox и не меняет sysctl.
Для обычного запуска должны работать unprivileged user namespaces. AppImage требует FUSE
либо распаковки `--appimage-extract` и запуска `squashfs-root/AppRun`.

## Подпись и notarization

Запускать только на доверенном, проверенном checkout:

```text
pnpm package:signed
```

Сборка завершается ошибкой до компиляции, если отсутствует обязательный параметр:

| Параметр окружения                     | Назначение                                                      |
| -------------------------------------- | --------------------------------------------------------------- |
| `APP_BUNDLE_ID`                        | Финальный reverse-DNS ID, отличный от dev ID                    |
| `APP_PRODUCT_NAME`                     | Утверждённое имя; влияет на пути настроек и Keychain            |
| `APP_PUBLISHER`                        | Реальный издатель                                               |
| `APP_HOMEPAGE`                         | Утверждённый сайт                                               |
| `CSC_LINK`, `CSC_KEY_PASSWORD`         | Сертификат с private key и его пароль                           |
| `APPLE_API_KEY`                        | Только macOS: путь к временному `.p8` App Store Connect API key |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Только macOS: ID ключа и issuer                                 |

macOS использует **Developer ID Application**, hardened runtime и timestamp/signing средствами
electron-builder. В entitlements только `com.apple.security.cs.allow-jit`: для JIT Electron/V8.
Нет `get-task-allow`, отключения library validation, unsigned executable memory, App Sandbox
или групп совместного доступа к Keychain. `preAutoEntitlements` выключен, strict verification
включён. Это desktop-приложение вне Mac App Store, не MAS sandbox package.
Notarization включена; встроенный `@electron/notarize` отправляет приложение Apple и staples
ticket. Ошибки подписи/notarization не превращают candidate в успешный unsigned artifact.
После копирования из DMG smoke-script проверяет `codesign`, `stapler` и `spctl`.
Настройки сверены с [electron-builder mac options](https://www.electron.build/mac/)
и [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Секреты не должны попадать в репозиторий, команды с literal passwords, screenshots или artifacts.
Для локального запуска передавайте их из защищённого окружения. Сохраняйте постоянными
Developer ID identity, bundle ID и product name между версиями. Смена имени/identity требует
отдельной миграции и проверки Keychain, а не копирования ciphertext с обещанием совместимости.
Signed candidate использует MIT для кода OpenSCP; сам запуск workflow не публикует релиз.

## CI

`ci.yml` проверяет исходники на трёх ОС, включая filesystem/permissions/symlinks, storage policy
и packaging contracts. `packages.yml` собирает dev packages на Windows x64, Ubuntu 22.04 x64,
macOS 15 arm64 и выполняет smoke из установленной/скопированной сборки. Теги с префиксом `v`
запускают этот workflow; после успешной сборки всех платформ он автоматически создаёт GitHub
Release и прикладывает Windows, Linux и macOS пакеты. Англоязычное описание берётся из
`docs/release/notes/<tag>.md`; без такого файла используются сгенерированные GitHub release notes.
Повторный запуск workflow заменяет пакеты и обновляет curated description существующего релиза
без создания дубликата.
Архитектура Mac проверяется явно, без молчаливого перехода на Rosetta.
Выбранные labels сверены с [таблицей GitHub runners](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).

Linux CI поднимает реальные OpenSSH/MinIO, проверяет upload/download обоих протоколов и
повторное подключение после рестарта. Windows/macOS hosted CI проверяет запуск, IPC,
сохранение и decrypt canary после рестарта; сетевые smoke запускаются отдельно с fixtures.
Это различие намеренно: на стандартных macOS/Windows hosted runners нет нашего Linux Docker
fixture environment. Локальный Windows full protocol smoke выполняется с Docker Desktop.

`signed-packages.yml` запускается **только вручную**, работает в environment `release-signing`,
не создаёт GitHub Release и не выполняется на pull_request. Владелец должен включить protection
rules / required reviewers и ограничить разрешённые branches/tags. Переменные identity задаются
в этом environment. Секреты: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `WINDOWS_CSC_LINK`,
`WINDOWS_CSC_KEY_PASSWORD`, `APPLE_API_KEY_CONTENT` (содержимое PEM), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`. `.p8` создаётся с mode 0600 во временной папке runner и удаляется в `always()`.
Загружаются только готовые packages, не userData, keychain, certificate, build debug logs или traces.
Windows workflow проверяет Authenticode; macOS — signed app, ticket и Gatekeeper.
Hosted workflows в рамках локальной реализации не запускались.

## Проверки установленных пакетов

Windows, в рабочей копии, без уже установленного dev-приложения:

```powershell
pnpm fixtures:up
./scripts/smoke-installed-windows.ps1 -InstallerPath ./release/openscp-0.2.0-win-x64-setup.exe -Protocols
pnpm fixtures:down
```

Скрипт отказывается перезаписывать существующую установку. Создаёт уникальную папку
`release/installed-smoke-*`, ставит туда NSIS, использует отдельный временный userData,
проверяет копирование Unicode-файла Local ↔ SFTP и Local ↔ S3, затем uninstall и cleanup.
Все remote writes идут только в disposable fixtures с уникальными именами.

Linux из Windows/Docker Desktop, без изменения установленной ОС:

```powershell
pnpm fixtures:up
docker build -f tests/packaging/Dockerfile -t openscp-packaging:t20 .
$artifactDirectory = (New-Item -ItemType Directory -Force release/linux-container).FullName
docker run --rm --init -e OPENSCP_INTEGRATION=1 --mount "type=bind,source=$artifactDirectory,target=/artifacts" openscp-packaging:t20
pnpm fixtures:down
```

Контейнер собирает настоящий Linux ELF, устанавливает DEB через dpkg и запускает Electron
не от root, под Xvfb с отдельным D-Bus/GNOME Keyring. TCP proxies соединяют исключительно
тестовые loopback endpoints с fixture ports Docker Desktop. Это не настройка приложения.
Отдельный тест запускает настоящий `--password-store=basic` и проверяет отказ сохранить
профиль/секрет. Контейнерный harness использует **только для теста** `--no-sandbox`, поскольку
Docker ограничивает вложенные namespaces; это не доказательство работоспособности Chromium
sandbox на произвольном desktop Linux. Native Ubuntu CI этот флаг не устанавливает.
Нельзя переносить его в desktop launcher или рекомендовать пользователю отключать sandbox.

macOS: `bash scripts/smoke-installed-macos.sh release/<точное-имя>.dmg`.
Скрипт монтирует DMG read-only и копирует app в отдельную папку, а не запускает из build output.
Для сетевых smoke предварительно подготовить fixtures и установить `OPENSCP_INTEGRATION=1`.
Для signed checks также установить `OPENSCP_SIGNED_BUILD=1`.

`linux-keyring-smoke.sh` запускается только с `OPENSCP_DISPOSABLE_KEYRING=1`:
не применяйте его к реальному пользовательскому HOME/Keyring. Container/CI harness задаёт
этот флаг сам. AppImage smoke проверяет распакованный `AppRun`, без зависимости от FUSE.

## Незакрытая ручная приёмка T19

Без физического Apple Silicon, сертификата владельца и утверждённого ID нельзя честно
объявить T19 полностью завершённым. Нужен следующий протокол на чистом macOS-пользователе:

1. Скачать signed DMG обычным браузером (с quarantine attribute), открыть Finder и скопировать
   app в Applications. Не удалять quarantine и не обходить Gatekeeper.
2. Проверить успешные `codesign --verify --deep --strict`, `xcrun stapler validate`,
   `spctl --assess --type execute`; запустить приложение из Finder.
3. Выполнить installed SFTP/S3 smoke и SSH Agent authentication через `SSH_AUTH_SOCK`.
4. Сохранить только тестовый секрет, закрыть приложение, перезапустить; повторить connect.
   Затем проверить обновление другой сборкой с теми же ID/Developer ID.
5. В disposable окружении подписать тестовую копию другим bundle ID с тем же product name
   (чтобы тест действительно обращался к тому же Keychain service), дать ей копию тестового
   ciphertext. Она не должна получить plaintext без явного разрешения пользователя в Keychain.
   **Не нажимать Allow/Always Allow**. Проверить также другой product name и подпись.
6. Зафиксировать macOS/CPU, Team ID, bundle ID, hashes артефактов, backend и результаты;
   не включать значения секретов в отчёт.

Не считать различие путей userData доказательством изоляции Keychain. Гарантия safeStorage
зависит от платформы, подписи и разрешений пользователя; это не собственный криптографический
контейнер приложения. Подробности для пользователя — `docs/user/platforms.md`.
