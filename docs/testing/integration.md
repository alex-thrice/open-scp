# Интеграционное окружение OpenSSH, FTP и MinIO

Требования: Docker с Linux containers / Docker Compose v2, Node.js и pnpm из настроек проекта,
`ssh-keygen` в PATH. Все порты публикуются только на `127.0.0.1`. Не используйте это окружение
как публичный сервер.

```sh
pnpm fixtures:up
pnpm test:integration
pnpm fixtures:down
```

`fixtures:up` генерирует одноразовый тестовый ключ, пересоздаёт контейнеры, ожидает успешных
health checks и заполняет MinIO. Повторный запуск очищает серверное состояние. FTP fixture
собирается из закреплённого Alpine и vsftpd, слушает только loopback и passive-порты.
`fixtures:wait`
ожидает готовности уже созданных серверов. `fixtures:down` удаляет только контейнеры и volumes
Compose-проекта `openscp-integration`. Сгенерированный клиентский ключ остаётся в
игнорируемом `tests/fixtures/runtime/`; его можно использовать повторно.

## Только фиктивные credentials

| Сервис  | Адрес                    | Пользователь / ключ   | Тестовый пароль / секрет             |
| ------- | ------------------------ | --------------------- | ------------------------------------ |
| OpenSSH | `127.0.0.1:22222`        | `fixture`             | `fixture-password-only`              |
| FTP     | `127.0.0.1:21210`        | `fixture`             | `fixture-ftp-password-only`          |
| MinIO   | `http://127.0.0.1:29000` | `fixture-access-only` | `fixture-secret-only-not-production` |

Passphrase генерируемого SSH-ключа: `fixture-passphrase-only`. Эти значения намеренно публичные,
не являются production-секретами и не должны использоваться вне fixtures. В контейнере OpenSSH
выключены PerSourcePenalties: сценарии unknown/changed key и неправильного пароля многократно
создают неуспешные подключения с одного адреса. Это настройка только тестового сервера.

SFTP fixtures находятся в `/home/fixture/data`: Unicode-каталог, файл с пробелами, симлинк,
каталог с запрещённым доступом и sparse-файл 256 МиБ. Каждый тест файловых операций создаёт
отдельный каталог и удаляет только его.

MinIO содержит `fixture-bucket`, `fixture-empty`, Unicode key, prefix, zero-byte object и
80-МиБ `multipart.bin`. При проверке seed-сценария получен multipart ETag с суффиксом `-5`.
Пользователь `fixture-readonly` / `fixture-readonly-password-only` имеет только ListBucket,
GetBucketLocation и GetObject в fixture-bucket. Это также исключительно фиктивные credentials.
Политика не разрешает запись, что проверяет read-only test connection и отказ upload.

## Проверка пользовательского сценария

```sh
pnpm test:e2e
pnpm test:e2e:integration
```

Вторая команда требует запущенных fixtures и рабочего безопасного хранилища ОС. Она запускает
Electron с отдельными временными userData и локальным корнем, создаёт SFTP-профиль, подтверждает
fingerprint, выполняет файловые операции, upload/download и перезапуск. Проверяется, что пароль
не находится открытым текстом в SQLite и соединение после перезапуска использует сохранённые
credentials и доверенный ключ. Тестовые директории удаляются по завершении.
S3 E2E создаёт encrypted профиль MinIO, держит две S3-вкладки и одну SFTP одновременно,
проверяет copy/rename, preview/delete prefix и upload/download через общую очередь.
FTP E2E проверяет постоянное предупреждение о незашифрованном протоколе, навигацию,
Local ↔ FTP передачу, отсутствие пароля в SQLite и повторное подключение после перезапуска.

После `pnpm package` дополнительно можно проверить именно packaged-приложение (PowerShell):

```powershell
$env:OPENSCP_PACKAGED_EXE = (Resolve-Path 'release/win-unpacked/OpenSCP.exe').Path
pnpm exec playwright test packaged-smoke.spec.ts
Remove-Item Env:OPENSCP_PACKAGED_EXE
```

Smoke-тест использует отдельный временный userData, проверяет изоляцию renderer, SQLite,
шифрование и сохранение профиля после перезапуска; сетевое подключение не выполняется.
Если дополнительно установлен `OPENSCP_INTEGRATION=1`, packaged smoke проверяет
S3-подключение и download фиктивного объекта MinIO в отдельный временный userData.

Обычный `test:e2e` не запускает серверный сценарий без явного флага. Integration tests с Docker
fixtures намеренно не запускаются в CI и выполняются вручную командами выше. Проверка реального
Electron safeStorage выполняется на desktop, где доступен безопасный backend; небезопасный
`basic_text` не включается ради прохождения CI.

## Проверки T04–T10

- SQLite migration 1 → 2 и повторное применение; сохранность настроек.
- Шифрование, замена, удаление и повреждение credentials; запрет небезопасного backend.
- Unknown/changed host key, password, encrypted private key, неверная аутентификация.
- Общий provider contract, Unicode, permissions, отсутствие пути, удаление самого симлинка.
- Local ↔ SFTP, recursive copy, ask/overwrite/skip/rename, cancel, обрыв SSH, resume и restart.
- Передача sparse-файла 256 МиБ: в финальном локальном прогоне 2026-09-04 прирост peak RSS
  тестового процесса составил около 9 МиБ. Автоматический бюджет — менее 192 МиБ сверх baseline.
  Это измерение конкретного тестового процесса, не абсолютная память всего Electron-приложения.

## Проверки T11–T13

- Общий S3 provider contract, pagination objects/buckets, Unicode, percent-encoding, zero-byte.
- Read-only test connection, неверные credentials, типизированные DNS/TLS/endpoint ошибки.
- Secret key и session token: шифрование, сохранение/удаление, запрет TLS override в IPC.
- Copy не перезаписывает existing object; rename явно неатомарен; prefix delete привязан к manifest.
- Multipart: parts 8 МиБ, concurrency ≤ 2, Content-MD5, условный complete, cancel/abort,
  persistent cleanup при неудаче, retry с нуля, Range resume и проверка ETag.
- 256-МиБ S3 roundtrip: прирост peak RSS около 78 МиБ в локальном прогоне; бюджет < 192 МиБ.
- Особенности MinIO (`//`, `.` и `..` в keys, условный CopyObject) проверены и описаны в
  `docs/architecture/s3.md`; ключи не изменяются ради обхода ограничений backend.

Команды: `pnpm test`, `pnpm test:integration`, `pnpm test:e2e:integration`.
Live AWS credentials не требуются и не использовались.

## Проверки T30

- FTP profile сохраняется отдельно от encrypted password и импортируется/экспортируется без
  credentials.
- Passive connect, password failure, UTF-8, MLSD или fallback `LIST -a`/`LIST`, list/stat,
  mkdir, rename/move, recursive delete и bounded streaming проверяются на vsftpd.
- Общий provider contract запускается для FTP; capabilities не обещают FTPS, resume, atomic
  rename, permissions или symbolic links.
- Local ↔ FTP использует общую очередь и фактический conflict prompt; SFTP/S3 regression tests
  остаются в тех же suites.

Команды: `pnpm test`, `pnpm test:integration`, `pnpm test:e2e:integration`.

## Проверки T14–T17

- Durable queue: никакого подключения/записи до явного повтора после рестарта.
- Ошибка после final rename требует review; автоматического разрушительного retry нет.
- Классификация ошибок, три попытки transient reconnect, bounded jitter.
- SFTP ↔ S3 roundtrip 256 МиБ, SHA-256, около 75 МиБ прироста peak RSS при бюджете <192 МиБ.
- Multi-select, Ctrl+A, F2/F5/F7/Delete, подтверждение удаления, контекстное меню.
- Внутренний DnD и системный File, прошедший `webUtils.getPathForFile`, идут через очередь.
- Поиск/группы, архив профилей без credentials, явный known_hosts import без замены changed key.
- Закрытие вкладки с подтверждением отмены и сохранением общей истории; restart requiring review.
- Диагностический report без секретов и private metadata, RU/EN parity/plurals/Intl formats.
- Русский интерфейс и native menus переключаются без рестарта; Playwright проверяет ширину
  документа и сохраняет `commander-ru.png`/`connected-ru.png` для визуальной проверки.

Новые сценарии: `tests/e2e/product-workflow.spec.ts`,
`tests/integration/remote-transfers.test.ts`, `tests/main/queue-recovery.test.ts`,
`tests/main/profile-library.test.ts`, `tests/main/localization.test.ts`.

Финальный Windows-прогон T14–T17 (2026-09-04): lint/typecheck успешны;
unit — 106 passed / 1 platform skip; integration — 31 passed; Playwright — 7 passed,
включая packaged smoke с реальным S3 download.

T19/T20 добавляют установленный NSIS/DEB и AppImage smoke: оба протокола в обе стороны,
реальный decrypt после рестарта и Linux basic_text refusal. Проверки и артефакты описаны
в `docs/testing/packaging.md`; T18 при этом намеренно не выполнялся.
