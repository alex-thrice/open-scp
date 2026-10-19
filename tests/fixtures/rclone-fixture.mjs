import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

const root = resolve(process.env.OPENSCP_RCLONE_FIXTURE_ROOT);
const [command, ...args] = process.argv.slice(2);
const operands = args.filter((argument) => !argument.startsWith('--'));
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
  if (command === 'listremotes') {
    process.stdout.write(`icloud: ${behavior.remoteType ?? 'iclouddrive'}\nsecond: iclouddrive\n`);
  } else if (command === 'lsjson') {
    if (behavior.invalidJson) {
      process.stdout.write('broken-json');
      process.exit(0);
    }
    const path = pathFor(operands[0]);
    const result = args.includes('--stat')
      ? await entry(path, basename(path))
      : await Promise.all((await readdir(path)).map((name) => entry(join(path, name), name)));
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
