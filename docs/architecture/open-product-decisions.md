# Продуктовые решения

2026-09-04 по запросу владельца зафиксированы:

- название приложения: **OpenSCP**;
- репозиторий: `https://github.com/alex-thrice/open-scp.git`;
- лицензия независимого кода и ресурсов: **MIT**;
- техническое имя npm/DEB, команды Linux и префиксы артефактов: `openscp`;
- префикс переменных окружения: `OPENSCP_`.

Проверка лицензий зависимостей и состав уведомлений: `THIRD_PARTY_NOTICES.md`.
Разработка сохраняет независимость от кода и ресурсов WinSCP согласно ADR 0005.

До публичного подписанного релиза остаётся определить окончательный bundle identifier,
издателя и канал распространения. Development ID — `com.electron.openscp`.
GitHub Actions сохраняет артефакты проверки, но не публикует GitHub Release.

Signed candidate требует `APP_BUNDLE_ID`, `APP_PRODUCT_NAME` (OpenSCP), `APP_PUBLISHER`,
`APP_HOMEPAGE` и сертификаты. macOS development package подписывается только ad-hoc,
что не даёт доверия Gatekeeper. Инструкции и приёмка — `docs/release/packaging.md`.

Настройки новой идентичности хранятся отдельно. Для переноса используйте экспорт/импорт
профилей без секретов и повторно задайте credentials; автоматическая миграция Keychain
не заявляется.

Более поздние решения перечислены в `IMPLEMENTATION_PLAN.md`: updater, crash telemetry,
минимальные версии ОС, дополнительные S3-системы и keyboard-interactive SFTP authentication.
