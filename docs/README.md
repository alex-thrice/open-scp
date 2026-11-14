# Documentation

[Русский](README.ru.md) · [Overview and downloads](../README.md)

## Using OpenSCP

- [Getting started](user/getting-started.md)
- [Install rclone and PuTTY](user/getting-started.md#additional-tools)
- [Files, tabs and keyboard shortcuts](user/commander.md)
- [Installation, updates and platform notes](user/platforms.md)

## Connection guides

- [Mail.ru Cloud](user/mailru.md)
- [Yandex Disk](user/yandex.md)
- [Google Drive](user/google.md)
- [iCloud Drive with rclone](user/icloud.md) — experimental

These guides assume that you already have a service account. They describe
sign-in, permission approval and application settings. Google verification is
pending, so Google Drive access may currently be limited.

## Development and maintenance

- [Build from source and development commands](development.md)
- [Provider architecture](architecture/provider-semantics.md) — Russian
- [Architecture decisions](adr)
- [Integration tests](testing/integration.md) — Russian
- Maintainer setup (Russian): [Google](development/google-oauth.md),
  [Yandex](development/yandex-oauth.md), [advanced rclone configuration](development/icloud-rclone.md)
- Acceptance checklists (Russian): [Mail.ru](testing/mailru.md), [iCloud](testing/icloud.md)
- [Packaging and releases](release/packaging.md) — Russian
- [Documentation and media workflow](documentation.md) — Russian
