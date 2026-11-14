# Documentation screenshots

These PNGs show the actual OpenSCP Electron application on Windows, at a content
size of 1440 × 900. English and Russian variants use the same scenarios.

All files are synthetic. Connection profiles use reserved `example.com` addresses
and never connect to a server. The capture uses an isolated application profile,
an explicit local root and a separate rclone configuration. No personal files,
cloud accounts or credentials are used.

Regenerate with `pnpm docs:media`. The source is
[`scripts/capture-documentation.mjs`](../../scripts/capture-documentation.mjs).
See the [media workflow](../documentation.md#снимки-и-ролики) for video recording.

| Name                      | Content                                  |
| ------------------------- | ---------------------------------------- |
| `workspace[-ru].png`      | Completed copy between two local folders |
| `copy[-ru].png`           | Source and destination confirmation      |
| `connections[-ru].png`    | Saved demo profiles and folders          |
| `settings[-ru].png`       | Appearance settings                      |
| `workspace-dark[-ru].png` | Dark theme                               |
