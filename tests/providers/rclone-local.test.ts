// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RcloneProcess } from '../../src/main/providers/icloud/rclone-process';

it.skipIf(!process.env.OPENSCP_TEST_RCLONE_BINARY)(
  'streams through a real rclone binary using only disposable local files',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-real-rclone-'));
    const config = join(root, 'rclone.conf');
    await writeFile(config, '[local]\ntype = local\n');
    vi.stubEnv('OPENSCP_RCLONE_PATH', process.env.OPENSCP_TEST_RCLONE_BINARY ?? '');
    vi.stubEnv('RCLONE_CONFIG', config);
    const runner = new RcloneProcess({
      id: randomUUID(),
      kind: 'icloud',
      name: 'Local CLI smoke',
      remote: 'local',
      timeout: 5000,
    });
    const remote = `local:${root.replaceAll('\\', '/')}/file.txt`;
    try {
      expect(await runner.output(['listremotes', '--long'], 'connect')).toMatch(/local:\s+local/u);
      await expect(
        runner.json(['lsjson', '--stat', `${remote}.missing`], 'stat'),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
      await runner.run(['mkdir', `${remote}.directory`], 'create-directory');
      expect(await runner.json(['lsjson', '--stat', `${remote}.directory`], 'stat')).toMatchObject({
        IsDir: true,
      });
      expect(await runner.json(['lsjson', `${remote}.directory`], 'list')).toEqual([]);
      await runner.run(
        ['moveto', `${remote}.directory`, `${remote}.empty`, '--immutable'],
        'rename',
      );
      await runner.run(['rmdir', `${remote}.empty`], 'delete');
      const pending = runner.start(['rcat', remote, '--size', '7'], 'write');
      pending.child.stdout.resume();
      pending.child.stdin.end('payload');
      await pending.done;
      expect(
        await runner.json(['lsjson', '--stat', '--no-mimetype', remote], 'stat'),
      ).toMatchObject({ Name: 'file.txt', Size: 7, IsDir: false });
      expect(await runner.output(['cat', remote], 'read')).toBe('payload');
      await runner.run(['moveto', remote, `${remote}.renamed`, '--immutable'], 'rename');
      expect(await readFile(join(root, 'file.txt.renamed'), 'utf8')).toBe('payload');
      await runner.run(['deletefile', `${remote}.renamed`], 'delete');
    } finally {
      await runner.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
