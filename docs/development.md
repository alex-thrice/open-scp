# Building and developing OpenSCP

To use the application, start with the [README](../README.md) or
[getting started](user/getting-started.md). This guide covers source builds and implementation.

## Requirements and setup

- Node.js 24.20.0 LTS; `.nvmrc` records the development version.
- pnpm 11.24.0; `package.json` pins the package manager.

Clone the repository and run these commands from its root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

## Commands

| Command                      | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `pnpm dev`                   | Start Electron with the development renderer            |
| `pnpm lint`                  | ESLint and Prettier checks                              |
| `pnpm typecheck`             | Main, preload, shared and renderer TypeScript checks    |
| `pnpm test`                  | Unit and provider contract tests                        |
| `pnpm test:packaging`        | Packaging configuration tests                           |
| `pnpm licenses:check`        | Check and generate runtime dependency notices           |
| `pnpm build`                 | Build into `out/`                                       |
| `pnpm test:e2e`              | Build and run Electron UI tests                         |
| `pnpm test:e2e:integration`  | Build and run UI tests with disposable network fixtures |
| `pnpm package`               | Build packages for the current platform into `release/` |
| `pnpm docs:media`            | Capture documentation screenshots with synthetic data   |
| `pnpm docs:media -- --video` | Also record three clips in each interface language      |

See [integration fixtures](testing/integration.md) for local servers and
[documentation media](documentation.md#снимки-и-ролики) for capture details.
Fixtures do not establish real-service acceptance.

GitHub Actions runs lint, type checking, unit/packaging tests, license checks,
builds and Electron UI tests on Windows, Linux and Apple Silicon macOS. UI network
tests use temporary SFTP/S3 servers; Linux uses a disposable keyring.

## Identity and packages

The product is **OpenSCP**. Package names, Linux commands and artifact prefixes use
`openscp`; development/test environment variables use `OPENSCP_`.
The identity has its own user-data directory. When migrating from an older development
identity, explicitly export/import profiles and re-enter credentials.

`pnpm package` creates Windows x64 NSIS/portable, Linux x64 AppImage/DEB, or
macOS arm64 DMG/ZIP packages on the respective platform. macOS requires Apple Silicon;
ordinary packages use ad-hoc signing. `pnpm package:signed` fails closed without
the required identity and signing credentials. Signing configuration alone does
not establish Gatekeeper or Keychain acceptance.

Version tags start `.github/workflows/packages.yml`, which builds packages,
checks installation and launch, and publishes the GitHub Release. Linux checks
include OpenSSH/MinIO integration with the installed package. Signed candidates
use a separate manual workflow.

See [packaging and release checks](release/packaging.md),
[package testing](testing/packaging.md) and [platform differences](user/platforms.md).

## Process boundaries and IPC

The application uses Electron, React, Vite and strict TypeScript.

- `src/main` owns the Electron lifecycle and system access.
- `src/preload` exposes a narrow, typed `contextBridge` contract.
- `src/renderer` is a sandboxed React application without Node.js or Electron imports.
- `src/shared` contains process-neutral contracts.

ESLint protects the import boundaries. Browser windows use `nodeIntegration: false`,
`contextIsolation: true` and renderer sandboxing.

The renderer receives named methods and event subscriptions, never `ipcRenderer`
or arbitrary channel access. Contracts live in `src/shared/ipc`; main handlers
validate payloads with Zod. Responses include a correlation ID and a discriminated
result. Serialized errors expose codes and localization keys without exception
messages, stack traces, paths or payloads. Navigation, redirects and new windows
are blocked. Packaged builds add a strict CSP without `unsafe-eval`.

## Providers and transfers

The shared domain defines secret-free profiles, provider paths, file entries,
connection lifecycle, normalized errors, transfer operations and capability flags.
`FakeProvider` and `LocalProvider` share a contract test suite. `LocalProvider` has
an explicit root, rejects traversal and intermediate symlinks, deletes links
without following them, and uses bounded Web Streams.

Local drive discovery and filesystem operations use fixed, validated IPC channels.
Each root has its own bounded provider. `OPENSCP_LOCAL_ROOT` confines a development
or test launch to one directory and prevents enumeration of other drives. Use a
separate `--user-data-dir` as well when creating public media.

Credentials stored by OpenSCP use Electron safeStorage; insecure backends are refused.
Google and iCloud credentials are managed separately by rclone. Paths and
transfer state have provider-specific semantics:

- [Provider capabilities](architecture/provider-semantics.md)
- [Persistence, SFTP and transfers](architecture/persistence-sftp-transfers.md)
- [S3 multipart and objects](architecture/s3.md)
- [Commander, recovery and security](architecture/commander-recovery.md)
- [Mail.ru WebDAV](architecture/mailru.md)
- [Yandex OAuth and REST](architecture/yandex.md)
- [Google Drive through rclone](architecture/google.md)
- [iCloud/rclone decision](adr/0011-icloud-rclone.md)

## Cloud application configuration

Yandex sign-in in distributed packages depends on the release owner's OAuth client
configuration. For a custom build, copy the empty key from `.env.example` into a
Git-ignored `.env.local` and supply the appropriate value:

```dotenv
OPENSCP_YANDEX_CLIENT_ID=
```

Vite passes this setting to the main bundle. Never commit credentials, tokens or
real environment values. Registration and acceptance checks are described in the
[Yandex maintainer guide](development/yandex-oauth.md).

Google Drive and iCloud use external rclone and its own configuration. OpenSCP
does not bundle or update rclone and no longer requires Google OAuth build
parameters. Google remotes are configured by users with their own OAuth client;
see the [Google guide](user/google.md). iCloud setup is described in the
[iCloud guide](user/icloud.md). Environment overrides, custom and encrypted
configurations, and command-line recovery are documented in the
[advanced rclone maintainer reference](development/icloud-rclone.md) (Russian).

Architecture decisions and the independent implementation boundary are recorded in
[ADRs](adr). Unresolved product choices are tracked in
[open product decisions](architecture/open-product-decisions.md).
