import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const run = (program, args) => {
  const result = spawnSync(program, args, { cwd: directory, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`${program} failed (${result.status}).`);
};
const compose = (...args) =>
  run('docker', ['compose', '-f', join(directory, 'compose.yml'), ...args]);
const action = process.argv[2];
if (action === 'up') {
  await mkdir(join(directory, 'runtime'), { recursive: true });
  const keyPath = join(directory, 'runtime', 'id_ed25519');
  if (!existsSync(keyPath))
    run('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      'fixture-passphrase-only',
      '-C',
      'disposable-test-key',
      '-f',
      keyPath,
    ]);
  compose(
    'up',
    '--build',
    '--force-recreate',
    '--wait',
    '--wait-timeout',
    '180',
    'ftp',
    'openssh',
    'minio',
  );
  compose('run', '--rm', 'seed-minio');
} else if (action === 'down') compose('down', '--volumes', '--remove-orphans');
else if (action === 'wait')
  compose('up', '--wait', '--wait-timeout', '180', 'ftp', 'openssh', 'minio');
else throw new Error('Expected up, wait or down.');
