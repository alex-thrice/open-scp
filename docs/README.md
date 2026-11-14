# Documentation / Документация

## Use OpenSCP / Работа с приложением

| Topic / Тема                                                  | English                                    | Русский                                     |
| ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| Overview and downloads / Обзор и скачивание                   | [README](../README.md)                     | [README](../README.ru.md)                   |
| First transfer / Первая передача                              | [Getting started](user/getting-started.md) | [Начало работы](user/getting-started.ru.md) |
| Keyboard and tabs / Клавиатура и вкладки                      | —                                          | [Руководство](user/commander.md)            |
| Installation and updates / Установка и обновления             | —                                          | [Особенности платформ](user/platforms.md)   |
| Mail.ru Cloud / Облако Mail.ru                                | —                                          | [Подключение](user/mailru.md)               |
| Yandex Disk / Яндекс Диск                                     | —                                          | [Подключение](user/yandex.md)               |
| Google Drive / Google Диск                                    | —                                          | [Подключение](user/google.md)               |
| iCloud Drive (experimental) / iCloud Drive (экспериментально) | —                                          | [Подключение](user/icloud.md)               |

[rclone and PuTTY setup](user/getting-started.md#additional-tools) /
[Установка rclone и PuTTY](user/getting-started.ru.md#дополнительные-программы).

The [project website](https://openscp.made-in-krim.ru/) is the user-facing entry point.
The repository keeps versioned guides and technical references.

Настройка OAuth и проверки разработчиком вынесены из пользовательских руководств.
Для использования настроенной готовой сборки регистрация своего OAuth-приложения не нужна.

## Build and maintain / Разработка

- [Source builds and development commands](development.md)
- [Architecture and provider semantics](architecture/provider-semantics.md)
- [Architecture decisions](adr)
- [Integration tests](testing/integration.md)
- OAuth setup and acceptance: [Google](development/google-oauth.md), [Yandex](development/yandex-oauth.md)
- Real-service acceptance: [Mail.ru](testing/mailru.md), [iCloud](testing/icloud.md)
- [Packaging and releases](release/packaging.md)
- [Documentation placement and media workflow](documentation.md)
