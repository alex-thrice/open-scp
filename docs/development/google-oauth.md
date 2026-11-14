# Google OAuth: настройка сборки и приёмка

Эта инструкция предназначена владельцу приложения и разработчикам собственной сборки.
Пользователям готового OpenSCP нужна [инструкция подключения](../user/google.ru.md).

Готовые публичные сборки используют общий клиент OpenSCP, который настраивает
владелец приложения. Создание проекта в Google Cloud Console, получение Client ID
и передача параметров сборке относятся только к разработке и выпуску собственной
сборки. Сейчас ожидается подтверждение Google; эта настройка не должна становиться
шагом пользовательской инструкции.

## Регистрация владельцем приложения

1. В [Google Cloud Console](https://console.cloud.google.com/) создайте проект OpenSCP.
   В **APIs & Services → Library** включите **Google Drive API**.
2. В **Google Auth platform → Branding** настройте название OpenSCP, email поддержки
   и контакт разработчика. Для публичного распространения подготовьте собственные
   страницы приложения и политики конфиденциальности, подтверждённый домен и сведения,
   запрашиваемые Google. Не публикуйте приложение с фиктивными реквизитами.
3. В **Audience** выберите External для обычных Google-аккаунтов, оставьте Testing
   и добавьте свой адрес в Test users. Internal подходит только для своей организации Workspace.
4. В **Data Access → Add or remove scopes** добавьте
   `https://www.googleapis.com/auth/drive`. Это restricted scope для работы со всем My Drive.
   Ограниченный `drive.file` не предоставляет навигацию по всему пользовательскому дереву.
5. В **Clients → Create client** выберите **Desktop app**, имя OpenSCP Desktop.
   Скопируйте Client ID. Web application, API key и service account для этого входа не подходят.
   Отдельный сервер callback регистрировать не нужно: desktop-клиент использует loopback
   `http://127.0.0.1:<случайный порт>/oauth/google/callback`.
6. Если выданный desktop-клиент требует `client_secret` при обмене кода, задайте также
   `OPENSCP_GOOGLE_CLIENT_SECRET` локально/в CI. Это credential установленного приложения,
   который невозможно скрыть внутри распространяемого exe; серверный секрет здесь не используется.
   Не добавляйте скачанный JSON credentials в репозиторий и не отправляйте его в чат.

Основания: [настройка consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent),
[создание desktop credentials](https://developers.google.com/workspace/guides/create-credentials),
[desktop OAuth и loopback](https://developers.google.com/identity/protocols/oauth2/native-app),
[права Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Настройка локальной сборки и GitHub Actions

Добавьте пустые ключи из `.env.example` в существующий **игнорируемый Git** файл `.env.local`
и заполните своими значениями:

```dotenv
OPENSCP_GOOGLE_CLIENT_ID=
OPENSCP_GOOGLE_CLIENT_SECRET=
```

Client ID обязателен, desktop secret — при необходимости. Реальные значения остаются вне
исходников. `pnpm dev`, `pnpm build` и `pnpm package` подхватывают файл через Vite и передают
параметры только main. Renderer их не получает. Изменение требует перезапуска dev/новой сборки.
Переменные окружения процесса имеют приоритет и поддерживаются также установленным приложением.

В репозитории GitHub откройте **Settings → Secrets and variables → Actions**:

- **Variables → New repository variable:** `OPENSCP_GOOGLE_CLIENT_ID`.
- При необходимости **Secrets → New repository secret:** `OPENSCP_GOOGLE_CLIENT_SECRET`.

Все workflow уже используют эти имена. Пустой Client ID допускает сборку, но отключает вход.
OAuth-клиент уже создан, локальная конфигурация заполнена. Переменные GitHub Actions
настраиваются отдельно в кабинете репозитория.

## Реальная приёмка и публичный релиз

Автоматические проверки используют фиктивный OAuth/API, а не Google-аккаунт. До завершения T33:

- [x] Создать OAuth-клиент и задать параметры в игнорируемом `.env.local`.
- [ ] Подтвердить тип Desktop app, включённый Drive API, scope и тестового пользователя.
- [ ] На настоящем аккаунте проверить вход, перезапуск/refresh, выход и отзыв доступа.
- [ ] Проверить одноимённые ID, rename, корзину и восстановление через сайт.
- [ ] Передать большой файл (не менее 1 ГиБ) Local ↔ Google, отменить, продолжить, сравнить hash.
- [ ] Проверить Google ↔ Mail.ru/Яндекс/SFTP/FTP/S3, включая restart источника без offset.
- [ ] Проверить запрет скачивания, права папок, Docs/Sheets/Slides export и лимит 10 МиБ.
- [ ] Записать ОС, дату и результаты в T33; проверить Windows/macOS/Linux с настоящим браузером.
- [ ] Отдельно завершить Google OAuth verification перед публичным распространением.

В Testing refresh token External-приложения с Drive scope обычно истекает через 7 дней —
потребуется новый вход. [Правила срока жизни токенов](https://developers.google.com/identity/protocols/oauth2/).
Для restricted scope публичное приложение зависит от проверки Google; дополнительные требования
зависят от обработки данных, включая серверную передачу/хранение.
[Требования restricted verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
Успешный тест на одном аккаунте не подтверждает готовность публичного OAuth-релиза.
