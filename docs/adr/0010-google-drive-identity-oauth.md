# ADR 0010: Google Drive — OAuth, адреса объектов и resumable upload

- Дата: 2026-10-19.
- Статус: принято для T33; OAuth-клиент создан; реальная приёмка и публичная верификация ожидаются.

## Решение

Используется Drive API v3, My Drive и OAuth Desktop app через системный браузер,
PKCE S256 и одноразовый callback на 127.0.0.1 с динамическим портом. Общий OAuth-сервис
T32 получает параметры Google `access_type=offline`, `prompt=consent select_account`,
регистронезависимый bearer и необязательный desktop client secret. Последний не считается
конфиденциальным серверным ключом; web/service-account credentials не принимаются.
Client ID/desktop secret задаются снаружи репозитория через `.env.local`/GitHub Actions.
Токены и refresh остаются в main/safeStorage; одновременный refresh объединяется.

Для навигации по всему My Drive нужен restricted scope
`https://www.googleapis.com/auth/drive`. `drive.file` ограничен выбранными/созданными файлами
и не подменяет этот сценарий. Регистрация, тестовые пользователи и верификация публичного
приложения — отдельные внешние зависимости; без них релиз не считается готовым.
Владелец создал OAuth-клиент и передал параметры; они заданы только в игнорируемом
`.env.local`. Настройка API/consent/test users и настоящий вход проверяются отдельно.

Путь `google` содержит цепочку ID/имён: `gdrive:/<id>~<encoded-name>/…`.
ID определяет существующий объект, ID предыдущего сегмента — родителя; имена используются
для показа. Новый объект имеет последний сегмент без ID и всегда задаёт точного родителя.
Никакой POSIX-нормализации к этим адресам не применяется. Проверяется принадлежность
цепочки корню My Drive. Shortcuts отображаются отдельно и не обходятся; Shared Drives
и внешнее дерево «Доступные мне» исключены.

Листинг, выделение, rename/trash и overwrite сохраняют точный ID. При совпадении имени
нескольких объектов очередь требует выбрать ID заменяемого объекта; случайный выбор
первой записи запрещён. Новый объект получает ID заранее через generateIds и сохраняет
его при повторе, чтобы потеря ответа не создавала скрытый дубликат. Overwrite использует
PATCH media выбранного ID, без предварительного удаления. DELETE в UI означает корзину.

Обычные файлы передаются потоками. Resumable upload использует последовательные чанки,
кратные 256 КиБ, ограниченный буфер и проверяет `Range` сервиса перед resume. URL сессии
ограничен upload origin Google и хранится только в памяти текущего запуска. Проверяется
неизменность источника; если источник не поддерживает безопасное чтение с offset,
передача перезапускается. Истёкшая сессия требует явного restart. Последний чанк отправляется
после проверки источника. Неопределённая финализация требует проверки результата.

Google Docs/Sheets/Slides экспортируются только явной командой с выбором формата.
Бинарная запись поверх native-документа запрещена. API export ограничен 10 МиБ;
подготовленный экспорт буферизуется с этим пределом и ограничением количества, чтобы
передаваться через общий контракт с известным размером. Обычные большие файлы не
буферизуются целиком. Capabilities конкретного объекта доходят до UI и повторно
проверяются в main; запрет скачивания/изменения не обходится.

API, upload и redirects валидируются независимо; Bearer не пересылается на signed hosts.
GET допускает ограниченный retry/backoff, мутации не повторяются вслепую. Результаты
покрываются OAuth/API fixtures, ID/conflict/resume tests и Electron; реальные аккаунты
и OAuth verification отмечаются отдельно в T33.

## Источники

- [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).
- [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
- [File IDs, имена и capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).
- [Resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
- [Download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads).
