# Яндекс Диск и desktop OAuth

Решение: [ADR 0009](../adr/0009-yandex-disk-oauth-rest.md).
`LoopbackOAuth` в main управляет браузером, случайными state/verifier, S256 и callback на
127.0.0.1. Один listener обслуживает независимые одноразовые состояния нескольких профилей;
проверяются method/Host/path, повторные параметры, срок и отмена. Ошибки и ответы браузеру
не раскрывают код или токены. Timeout ожидания входа — 3 минуты.

`OAuthVault` читает encrypted bundle через CredentialService, обновляет токены с запасом
60 секунд и объединяет refresh одного профиля. Поколение и ссылка на секрет защищают от
поздней записи после выхода/нового входа. Временная ошибка refresh сохраняет credentials,
invalid_grant удаляет их. `YandexAuthorization` проверяет UID до сохранения и запрещает
незаметную смену связанного аккаунта. Импорт/clone не переносят credentials и UID.

`YandexConnection` проверяет аккаунт через Disk info, `YandexProvider` реализует общий контракт,
`YandexApi` использует фиксированный HTTPS API. IPC содержит только профиль и безопасные
состояния. Endpoint, Client ID, код и токены из renderer не принимаются. SQLite-схема прежняя.
Client ID публичен и задаётся на сборке/runtime; без него UI объясняет недоступность входа.

Пути абсолютные относительно `disk:/`; строки не декодируются повторно. List запрашивает
страницы по 200, проверяет offset/total, дубли и родителя каждой записи. Ответ API ограничен
2 МиБ; общий листинг — 1 млн записей и 10000 страниц. MD5/ID/size/modified дают versionTag для
проверки неизменности источника, checksum capability при этом не объявляется.

Временные URL требуют HTTPS без userinfo и нестандартного порта, с хостом внутри
`disk.yandex.ru`, `disk.yandex.net`, `disk.yandex.com` или `storage.yandex.net`.
Каждый из максимум трёх download redirects проверяется заново. OAuth-заголовок получает
только API origin; signed upload/download его не получают. PUT redirects не выполняются.
Проверка реальных hosts входит в ручную приёмку; неизвестный host даёт безопасную ошибку.

Только GET повторяется при 429/503 (два повтора, backoff/Retry-After до 5 секунд) и один раз
после refresh на 401. Мутации автоматически не повторяются. DELETE использует
`permanently=false`. Ответ 202 опрашивается по проверенному URL operations каждые 500 мс,
с отменой и общим пределом ожидания 120 секунд между запросами. Одна HTTP-операция имеет
отдельный idle/connect timeout профиля. 401/403/404/409/429/507 нормализуются без raw body.

Общая очередь передаёт Web Streams с ограниченными буферами и backpressure, пишет во
временное имя и публикует через MOVE с явным overwrite. Предварительного DELETE назначения
нет. Неопределённый результат публикации требует review. Resume и атомарность rename не
объявляются. Local/Mail.ru/SFTP/FTP/S3 используют те же потоки без локального staging-файла.

Fixture endpoints доступны только через явную main-конфигурацию; development Electron требует
`OPENSCP_YANDEX_FIXTURE=1` и loopback `OPENSCP_TEST_YANDEX_ENDPOINT`. Packaged-сборка игнорирует
эти переменные. Тесты проверяют PKCE/callback, refresh, account binding, pagination, async
operations, signed URLs, CRUD, очередь 32 МиБ и Electron restart/sign-out/cancel.
Client ID приходит в сборку из `.env.local`/переменной CI, без значения в исходниках;
callback и права проверены по публичной
конфигурации. Реальный smoke пока ожидается: [руководство и чеклист](../user/yandex.md).
