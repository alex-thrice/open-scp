# Документация

[English](README.md) · [Обзор и скачивание](../README.ru.md)

## Работа с OpenSCP

- [Начало работы](user/getting-started.ru.md)
- [Установка rclone и PuTTY](user/getting-started.ru.md#дополнительные-программы)
- [Файлы, вкладки и горячие клавиши](user/commander.ru.md)
- [Установка, обновления и особенности платформ](user/platforms.ru.md)

## Инструкции подключений

- [Облако Mail.ru](user/mailru.ru.md)
- [Яндекс Диск](user/yandex.ru.md)
- [Google Диск через rclone](user/google.ru.md)
- [iCloud Drive через rclone](user/icloud.ru.md) — экспериментально

Предполагается, что аккаунт сервиса уже есть. Инструкции описывают вход, выдачу
доступа и настройки приложения. Для Google Диска нужен настроенный remote
во внешнем rclone с собственным OAuth-клиентом. Google и iCloud показываются
отдельно; для каждого аккаунта можно выбрать свой remote.

## Разработка и сопровождение

- [Сборка из исходников и команды разработки](development.md) — на английском
- [Архитектура провайдеров](architecture/provider-semantics.md)
- [Архитектурные решения](adr)
- [Интеграционные тесты](testing/integration.md)
- Настройка разработчиком: [Google](development/google-oauth.md),
  [Яндекс](development/yandex-oauth.md), [расширенная конфигурация rclone](development/icloud-rclone.md)
- Проверки настоящих аккаунтов: [Mail.ru](testing/mailru.md), [iCloud](testing/icloud.md)
- [Упаковка и выпуск](release/packaging.md)
- [Размещение документации и подготовка медиа](documentation.md)
