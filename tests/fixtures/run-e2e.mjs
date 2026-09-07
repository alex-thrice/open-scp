import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    require.resolve('@playwright/test/cli'),
    'test',
    'sftp-transfer.spec.ts',
    'ftp-transfer.spec.ts',
    's3-transfer.spec.ts',
    'product-workflow.spec.ts',
  ],
  { stdio: 'inherit', windowsHide: true, env: { ...process.env, OPENSCP_INTEGRATION: '1' } },
);
process.exitCode = result.status ?? 1;
