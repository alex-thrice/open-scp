# Third-party software in OpenSCP

OpenSCP's original code, documentation and generated artwork are licensed under
the [MIT License](LICENSE). Dependencies retain their own licenses; MIT does not
relicense third-party software.

## Dependency review

The interface contains selected Lucide icons, distributed under the ISC license,
including icons derived from Feather under MIT. Their copyright and license
texts are preserved in `src/renderer/src/components/LICENSE.lucide` and included
with packaged application resources as `licenses/LICENSE.lucide`.

The installed runtime dependency tree from `pnpm-lock.yaml` was reviewed on
2026-09-08. It uses MIT, Apache-2.0, BSD-3-Clause, ISC, Python-2.0,
BlueOak-1.0.0, 0BSD and Unlicense terms, which allow the original application
code to be released under MIT while retaining the dependencies' notices and
conditions.

| Direct dependency                   | Version  | License                                  |
| ----------------------------------- | -------- | ---------------------------------------- |
| @aws-sdk/client-s3                  | 3.1126.0 | Apache-2.0                               |
| basic-ftp                           | 6.2.1    | MIT                                      |
| electron-updater                    | 6.8.9    | MIT                                      |
| i18next                             | 26.4.0   | MIT                                      |
| react / react-dom                   | 19.2.8   | MIT                                      |
| react-i18next                       | 17.0.12  | MIT                                      |
| ssh2 (including its Pageant helper) | 1.17.0   | MIT                                      |
| zod                                 | 4.4.3    | MIT                                      |
| Electron runtime                    | 44.0.0   | MIT, with separately licensed components |

`pnpm licenses:check` walks installed production dependencies, optional dependencies
that are present and required peers. It rejects unreviewed license identifiers
or missing license texts. It generates an inventory and full license/copyright
notices in `build-resources/generated/licenses/`. Three reviewed AWS SDK
tarballs omit their license file; their notices use the Apache-2.0 text from
`@aws-sdk/client-s3`, from the same upstream repository. The exceptions are
pinned to exact package versions in the generator.
The `lazy-val` package omits its license file from the published tarball; its
MIT identifier, author and upstream repository were reviewed, and the generator
adds the standard MIT text with the package author's copyright notice.

Every package includes this file, OpenSCP's `LICENSE`, `licenses/DEPENDENCIES.txt`,
`licenses/dependencies.json`, `licenses/LICENSE.electron` and Electron's complete
`licenses/LICENSES.chromium.html` under its resources directory. This also
preserves notices for renderer/preload dependencies whose code is bundled.
The Chromium notice file covers embedded Chromium, Node.js, FFmpeg and other
runtime components under their respective terms, including LGPL components;
those components are not relicensed under MIT. Redistributors must honor their
applicable notice and source/relinking requirements as well.

## Independent implementation and test tools

OpenSCP does not include WinSCP code, translations or artwork. The reference
boundary is documented in [ADR 0005](docs/adr/0005-winscp-reference-boundary.md).
[WinSCP is GPL-3.0-or-later](https://winscp.net/eng/docs/license), with separately
restricted artwork; importing those materials would require a new review.

Docker, OpenSSH and MinIO are separate development/test services, not bundled
application dependencies. In particular, the AGPL-licensed MinIO server used
by disposable localhost fixtures does not change the license of this independent
S3 client. Redistributing or modifying the server has its own obligations.

Sources: [MIT terms](https://opensource.org/license/mit),
[AWS SDK license](https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE),
[Electron license](https://github.com/electron/electron/blob/main/LICENSE),
[MinIO license](https://github.com/minio/minio/blob/master/LICENSE), and
[GNU guidance on separate programs](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).
