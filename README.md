# OpenSCP

[Repository](https://github.com/alex-thrice/open-scp) ·
[CI](https://github.com/alex-thrice/open-scp/actions/workflows/ci.yml) ·
[MIT License](LICENSE)

Early-stage cross-platform desktop file client built with Electron, React, Vite, and strict
TypeScript. The application includes local drive browsing, independent workspaces, encrypted
connection profiles, SFTP and S3 browsing/file operations, and a shared streaming transfer queue
for Local ↔ SFTP, Local ↔ S3 and SFTP ↔ S3. T14–T17 add durable queue review, Commander
keyboard/multi-select/drag-and-drop, profile management and live English/Russian localization.

## Requirements

- Node.js 24.20.0 LTS (the exact development version is in `.nvmrc`)
- pnpm 11.24.0 (pinned in `package.json`)

Corepack can select the declared pnpm version:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Commands

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm licenses:check
pnpm build
pnpm package
```

GitHub Actions runs lint, type checking, unit/packaging tests, license checks, builds
and Electron UI tests on Windows, Linux and Apple Silicon macOS. UI regression tests use
temporary local SFTP/S3 servers; Linux runs them with a disposable keyring.
Development packages are built and smoke-tested by `packages.yml` on version tags,
including OpenSSH/MinIO integration for the installed Linux package; signed
candidates remain a manual workflow requiring signing credentials.

## License

OpenSCP's original code and artwork use the [MIT License](LICENSE).
See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses and the
independent implementation boundary. Packaging generates and includes the full
runtime dependency notices, including Electron/Chromium notices.

## Packaging and application identity

The application is named **OpenSCP**; package names, Linux commands and artifact
prefixes use `openscp`. Development/test environment variables use `OPENSCP_`.
The new identity uses a separate user-data directory; export/import profiles
explicitly when moving from an earlier development build and re-enter credentials.

`pnpm package` builds development packages in `release/`: Windows x64 NSIS/portable,
Linux x64 AppImage/DEB, macOS arm64 DMG/ZIP (ad-hoc only, requires Apple Silicon).
`pnpm package:signed` is fail-closed and requires owner-approved identity and signing secrets.
See [packaging and release checks](docs/release/packaging.md) and
[platform differences](docs/user/platforms.md). T18 was explicitly skipped; signing configuration
does not substitute for real Apple Silicon / Gatekeeper / Keychain acceptance.

## Process boundaries

- `src/main` owns the Electron lifecycle and system access.
- `src/preload` exposes a deliberately narrow, typed `contextBridge` contract.
- `src/renderer` is a sandboxed React application without Node.js or Electron imports.
- `src/shared` contains process-neutral contracts only.

ESLint import restrictions protect these boundaries, while the Electron window configuration
enforces `nodeIntegration: false`, `contextIsolation: true`, and renderer sandboxing.

## IPC security

- Renderer receives named methods and event subscriptions, never `ipcRenderer` or a method that
  accepts an arbitrary channel.
- Request, response, and event contracts live in `src/shared/ipc`.
- Main process handlers validate request and response payloads with Zod before crossing the IPC
  boundary.
- Every response carries a correlation ID and a discriminated success/failure result.
- Serialized errors contain only a machine code and localization key; exception messages, stack
  traces, paths, and payload values are not returned to renderer.
- Main process blocks navigation, redirects, and new windows. Packaged builds add a strict CSP
  response header without `unsafe-eval`.

## Architecture decisions

The initial decisions and the independent-implementation boundary are recorded in `docs/adr`.
Product choices that must not be guessed are tracked in
`docs/architecture/open-product-decisions.md`.

## Provider foundation

The shared domain layer defines connection profiles without embedded secrets, provider-specific
paths, file entries, transfer operations, connection lifecycle, normalized provider errors, and
explicit capability flags. `FakeProvider` and `LocalProvider` run against the same reusable
contract test suite.

`LocalProvider` is rooted at an explicit directory, rejects path traversal and intermediate
symlinks, deletes symlinks without following them, and uses bounded Web Streams for file content.
Protocol differences and the capability matrix are documented in
`docs/architecture/provider-semantics.md`.

## Local drives and workspaces

Each workspace has two independent panels. Both initially show local folders; either panel can
open a local drive, SFTP connection or S3 profile. The source picker searches names, groups
profiles into folders, and shows protocol icons and native OS drive icons where available.
Opening the picker refreshes removable drives. An inaccessible directory does not block
selecting another drive or returning to the previous listing.

Use **+** or Ctrl/Command+T to add a tab. Its title combines the left folder name with the
right folder name (local) or connection name (remote). A remote source picker is locked:
close the tab to disconnect. Closing the last connected tab creates a fresh local workspace.
The gear opens Settings: light/dark/system theme, density, hidden dotfiles and language.

Drive discovery and filesystem access run in the main process through fixed, validated IPC
channels. Each discovered root uses its own bounded `LocalProvider`; tabs do not change a shared
active root. On macOS and Linux, mounted disks remain accessible by their paths under `/`.
The development-only `OPENSCP_LOCAL_ROOT` override stays confined to the configured directory
and does not enumerate other drives. Arbitrary UNC paths and volume labels are not yet exposed
in the drive selector.

## SFTP and transfers

Open **Connections → Connection**, select SFTP, and choose password, private key or SSH Agent.
Double-click a saved profile to open it in the active local panel, or choose it in a source picker.
On the first connection, verify the displayed host fingerprint through a trusted channel before
explicitly accepting it. A changed key blocks connection. Secrets are encrypted with Electron
safeStorage and never returned to the UI; insecure storage backends are refused.

Select entries and use the panel's **Copy** icon or F5, then confirm the destination and conflict policy. Directories
are copied recursively. The queue shows progress, speed and ETA with cancel, resume and restart.
Completed transfers refresh the destination panel. Temporary `.openscp-part-…` files are published
only after success; interrupted parts remain available for verified resume during this run.
Queue intents survive restarts without credentials. Unfinished transfers require review and
never reconnect or resume automatically. An explicit restart copies from zero with conflict
prompts; old partial files remain untouched. Ambiguous commit failures also require review.

## S3 and multipart

Open **Connections → Connection** and select S3. For AWS leave Endpoint empty and select the region;
for MinIO specify its HTTPS endpoint and enable path-style when needed. Leave Bucket empty
to list buckets, or set a bucket and initial prefix. Secret access key and optional session
token are encrypted with safeStorage; HTTP is allowed only for local fixtures.

Buckets, prefixes and objects have distinct labels. Rename uses server-side copy and is
explicitly non-atomic. Prefix deletion shows the exact object count/bytes before confirmation.
Large uploads use multipart with bounded buffers, two in-flight parts and abort on cancellation.
Failed cleanup is recorded in SQLite and can be retried; do not delete the profile until cleanup
finishes. Download supports verified Range resume; interrupted uploads restart from zero.
Multiple S3 and SFTP sessions can stay connected in independent workspaces.

See [S3 semantics and limitations](docs/architecture/s3.md),
[integration setup](docs/testing/integration.md) and
[persistence/SFTP/transfer details](docs/architecture/persistence-sftp-transfers.md).

## Commander, profiles and diagnostics

Use F6 to switch panels, arrows/Home/End/PageUp/PageDown to navigate, Shift/Ctrl to select,
Ctrl+A to select all, F5 to copy to the opposite panel, F2 to rename, F7 to create a directory,
Delete to confirm deletion, F4 to refresh and Backspace to go up. Context menus expose only
provider-supported commands. Internal drops and operating-system file drops use the same queue.
Connect both panels to stream directly between SFTP/S3 sources using the same Copy action.

**Connections** provides search, folders, duplication, deletion and secret-free JSON import/export,
including empty folders. Imported password/S3 profiles need credentials configured before connecting.
**Settings → Advanced** contains known_hosts import and diagnostic export. Reports contain allowlisted technical metadata only;
they are never uploaded automatically. Both application and native menus switch language live.

See the [Commander guide](docs/user/commander.md) and
[recovery/security design](docs/architecture/commander-recovery.md) for limitations and details.
