import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers/promises';

const root = resolve(process.env.OPENSCP_RCLONE_FIXTURE_ROOT);
const [command, ...args] = process.argv.slice(2);
const operands = args.filter((argument) => !argument.startsWith('--'));
const configPath = join(root, 'gui-config.json');
let configured = {};
try {
  configured = JSON.parse(await readFile(configPath, 'utf8'));
} catch {
  /* Конфигурация создаётся по требованию. */
}
let behavior = {};
try {
  behavior = JSON.parse(await readFile(join(root, 'behavior.json'), 'utf8'));
} catch {
  /* Файл переопределений необязателен. */
}
if ((!behavior.command || behavior.command === command) && behavior.delay) {
  await setTimeout(behavior.delay);
}
if ((!behavior.command || behavior.command === command) && behavior.exit) {
  process.stderr.write(behavior.stderr ?? 'Fixture failure');
  process.exit(behavior.exit);
}
const pathFor = (operand) => {
  const index = operand.indexOf(':');
  const remote = operand.slice(0, index);
  const base = join(root, remote);
  const path = resolve(base, operand.slice(index + 1));
  if (!['icloud', 'second'].includes(remote) || relative(base, path).split(sep).includes('..')) {
    throw Object.assign(new Error('Invalid fixture path'), { code: 'EACCES' });
  }
  return path;
};
const entry = async (path, entryPath) => {
  const info = await stat(path);
  return {
    Name: basename(path),
    Path: entryPath,
    IsDir: info.isDirectory(),
    Size: info.isDirectory() ? -1 : info.size,
    ModTime: info.mtime.toISOString(),
    ID: String(info.ino),
  };
};
try {
  if (command === 'obscure') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(
      `fixture_012345678901234567890123_${Buffer.concat(chunks).toString('base64url')}\n`,
    );
  } else if (command === 'config') {
    const [operation, remote] = operands;
    const respond = (state, name, extra = {}) =>
      process.stdout.write(
        JSON.stringify({
          State: state,
          Error: '',
          Option: name ? { Name: name, ...extra } : null,
        }),
      );
    const result = process.env.RCLONE_RESULT ?? '';
    if (operation === 'delete') {
      configured = Object.fromEntries(
        Object.entries(configured).filter(([name]) => name !== remote),
      );
      await writeFile(configPath, JSON.stringify(configured));
    } else if (operation === 'create') {
      configured[remote] = { type: 'iclouddrive' };
      await writeFile(configPath, JSON.stringify(configured));
      respond('service', 'service');
    } else if (operation === 'update') {
      const state = process.env.RCLONE_STATE;
      if (state === 'service') respond('apple', 'apple_id');
      else if (state === 'apple') {
        configured[remote].apple_id = result;
        respond('password', 'password');
      } else if (state === 'password') {
        configured[remote].password = result;
        if (behavior.setupDelay) await setTimeout(behavior.setupDelay);
        respond('advanced', 'config_fs_advanced');
      } else if (state === 'advanced') respond('2fa', 'config_2fa');
      else if (state === '2fa' && result === 'sms')
        respond('phone', 'config_2fa_phone', {
          Examples: [
            { Value: '1_sms', Help: '+1 ••••12' },
            { Value: '2_sms', Help: '+1 ••••34' },
          ],
        });
      else if (state === 'phone') respond('sms', 'config_2fa_sms');
      else if (['2fa', 'sms'].includes(state) && result === '123456') respond('');
      else {
        process.stdout.write(
          JSON.stringify({
            State: state,
            Option: { Name: state === 'sms' ? 'config_2fa_sms' : 'config_2fa' },
            Error: 'secret-error-canary',
          }),
        );
      }
      await writeFile(configPath, JSON.stringify(configured));
    }
  } else if (command === 'version') {
    process.stdout.write(behavior.versionOutput ?? 'rclone v1.75.2\n');
  } else if (command === 'listremotes') {
    const remotes = {
      ...(behavior.remotes ?? {
        icloud: behavior.remoteType ?? 'iclouddrive',
        second: 'iclouddrive',
      }),
      ...Object.fromEntries(Object.entries(configured).map(([name, value]) => [name, value.type])),
    };
    process.stdout.write(
      Object.entries(remotes)
        .map(([name, type]) => (args.includes('--long') ? `${name}: ${type}\n` : `${name}:\n`))
        .join(''),
    );
  } else if (command === 'lsjson') {
    if (behavior.invalidJson) {
      process.stdout.write('broken-json');
      process.exit(0);
    }
    const path = pathFor(operands[0]);
    let result;
    if (args.includes('--stat')) {
      const item = await entry(path, basename(path));
      result = item.IsDir ? { ...item, Name: '', Path: '' } : item;
    } else
      result = await Promise.all(
        (await readdir(path)).map((name) => entry(join(path, name), name)),
      );
    process.stdout.write(JSON.stringify(result));
  } else if (command === 'mkdir') {
    await mkdir(pathFor(operands[0]), { recursive: true });
  } else if (command === 'cat') {
    const stream = createReadStream(pathFor(operands[0]), { highWaterMark: 65536 });
    if (behavior.truncate) {
      let sent = false;
      for await (const chunk of stream) {
        if (!sent) process.stdout.write(chunk.subarray(0, 1));
        sent = true;
      }
    } else {
      await pipeline(stream, process.stdout);
    }
  } else if (command === 'rcat') {
    const path = pathFor(operands[0]);
    await mkdir(dirname(path), { recursive: true });
    await pipeline(process.stdin, createWriteStream(path));
  } else if (command === 'moveto') {
    const from = pathFor(operands[0]);
    const to = pathFor(operands[1]);
    if (args.includes('--immutable')) {
      let exists = false;
      try {
        await stat(to);
        exists = true;
      } catch {
        /* Назначение может отсутствовать. */
      }
      if (exists) {
        process.stderr.write('immutable: destination exists');
        process.exit(1);
      }
    }
    await rename(from, to);
  } else if (command === 'deletefile') {
    await rm(pathFor(operands[0]));
  } else if (command === 'rmdir') {
    await rmdir(pathFor(operands[0]));
  } else if (command === 'purge') {
    await rm(pathFor(operands[0]), { recursive: true });
  } else {
    throw new Error('Unsupported fixture command');
  }
} catch (error) {
  process.stderr.write(error.code === 'ENOTEMPTY' ? 'directory not empty' : 'Fixture error');
  process.exit(error.code === 'ENOENT' ? 4 : 1);
}
