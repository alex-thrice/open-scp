# Google Drive API v3

Решение: [ADR 0010](../adr/0010-google-drive-identity-oauth.md).
Общий `LoopbackOAuth` поддерживает дополнительные параметры authorize, bearer любого регистра
и необязательный desktop credential. Google использует динамический loopback-порт, PKCE/state,
`access_type=offline`, `prompt=consent select_account`. `OAuthVault` разделяет виды провайдеров,
шифрует bundle, объединяет refresh и проверяет поколение при записи. `GoogleAuthorization`
проверяет `about.user.permissionId`; смена аккаунта требует выхода. В renderer/архив не попадают токены,
Client ID/desktop secret и upload URL. SQL-схема прежняя.

`google`-адрес сериализуется как `gdrive:/ID~encoded-name/ID~encoded-name`.
Имена percent-encoded, включая `/`, `?` и `~`; root — `gdrive:/`. Новый объект имеет только
последний сегмент `~encoded-name` без ID. Проверяются каноническая форма, длина, глубина
и идентификаторы. GoogleProvider проверяет реальную цепочку parents от корня My Drive;
shortcut, trashed и Shared Drive не становятся родителями. Имя не заменяет ID существующего файла.
Профили, recent paths, drag/drop, IPC и очередь сохраняют адрес без POSIX-нормализации.

List использует pageToken, проверяет повторные страницы, ID, parents и incompleteSearch.
`FileSystemEntry.google` содержит тип и capabilities объекта; те же поля доходят до UI.
Native-документ не считается обычным файлом. Явный `?export=MIME` разрешает только известные
форматы соответствующего native-типа. Подготовленный export имеет проверенную версию и размер,
буфер до 10 МиБ, максимум два результата с обновлением спустя минуту; disconnect очищает cache.
Shortcuts не разыменовываются. DELETE заменён PATCH `trashed:true`; rename/move использует ID.

Копирование native-документов Google → Google использует `FileSystemProvider.copyFrom`.
В одном аккаунте новый объект создаёт `files.copy`; в разных аккаунтах Docs/Sheets/Slides
экспортируются в DOCX/XLSX/PPTX и импортируются multipart-запросом с исходным Google MIME.
Назначение проверяет `about.importFormats`. Размер экспорта ограничен 10 МиБ, резервирование ID
для native-объектов не применяется. Замена native-документа допускается только на тот же тип
по выбранному ID с правом изменения содержимого; бинарная запись в native по-прежнему запрещена.
Права `canCopy`, `canDownload` для экспорта, версия источника и конфликты назначения проверяются
до публикации. Неопределённый ответ мутации переводит очередь в requiring-review без автоповтора.
Дочерние документы копируются и при рекурсивной передаче папок. История/комментарии и некоторые
возможности native-формата не сохраняются при промежуточном преобразовании между аккаунтами.

Обычный download потоковый, поддерживает проверенный Range. API получает Bearer только на
фиксированном origin Google; redirects на HTTPS `*.googleusercontent.com` проверяются отдельно
и не получают Authorization. JSON ограничен 8 МиБ на страницу. GET допускает два повтора для
rate/5xx с backoff до 5 секунд; мутации не повторяются вслепую. 401 запускает один refresh.
Ошибки scopes/permissions, quota и rate нормализуются без тела ответа/credentials.

Для нового файла generateIds резервирует ID до POST; повтор использует тот же ID.
Замена PATCH относится к явно выбранному binary ID. При нескольких одноимённых файлах
очередь публикует список ID и требует выбор, проверяемый main. Созданная папка разрешается
в ID до копирования детей. Клиент не создаёт случайный дубликат при неопределённом ответе.

Resumable-сессии и резервации живут в памяти provider текущего запуска. Буфер writer не больше
двух чанков по 1 МиБ; последний чанк ждёт проверки источника общим TransferEngine.
Progress учитывает только подтверждённые bytes. Финальный ответ сверяется с зарезервированным ID и полным размером; перед публикацией проверяется конкурирующее назначение. 308 Range сверяется с отправленным диапазоном;
status query не может увеличить offset сверх отправленных bytes или откатить подтверждение.
404/410 требует restart. Resume проверяет source size/modified/version и поддержку чтения с offset;
native export и источники Mail.ru/Яндекс без безопасного offset требуют restart.
Неопределённая публикация остаётся requiring-review. После restart приложения сессии не восстанавливаются.

Тестовые endpoint разрешены только через main-конфигурацию; development Electron требует
`OPENSCP_GOOGLE_FIXTURE=1` и loopback `OPENSCP_TEST_GOOGLE_ENDPOINT`. Packaged-сборка их игнорирует.
Реальный smoke и OAuth verification — отдельные пункты [приёмки](../user/google.md).
