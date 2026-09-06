import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { finishProfile, newConnection, openConnection } from './workspace-ui';

for (const side of ['left', 'right'] as const) {
  for (const bucket of ['', 'fixture-bucket']) {
    test(`opens S3 ${bucket ? 'bucket' : 'account root'} from a populated ${side} local pane`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'openscp-s3-pane-files-'));
      const userData = await mkdtemp(join(tmpdir(), 'openscp-s3-pane-user-'));
      const requests: string[] = [];
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        requests.push(`${request.method} ${path}`);
        if (request.method !== 'GET' || !['/', '/fixture-bucket/'].includes(path)) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('Content-Type', 'application/xml');
        response.end(
          path === '/'
            ? `<?xml version="1.0" encoding="UTF-8"?>
              <ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                <Buckets><Bucket><Name>fixture-bucket</Name>
                  <CreationDate>2026-09-01T12:00:00.000Z</CreationDate>
                </Bucket></Buckets>
              </ListAllMyBucketsResult>`
            : `<?xml version="1.0" encoding="UTF-8"?>
              <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                <Name>fixture-bucket</Name><Prefix></Prefix><KeyCount>1</KeyCount>
                <MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
                <Contents><Key>remote.txt</Key><Size>12</Size>
                  <LastModified>2026-09-01T12:00:00.000Z</LastModified>
                  <ETag>&quot;fixture-etag&quot;</ETag><StorageClass>STANDARD</StorageClass>
                </Contents>
              </ListBucketResult>`,
        );
      });
      let application: ElectronApplication | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No local S3 fixture port.');
        await writeFile(join(root, 'local.txt'), 'Local pane fixture.');
        const executablePath = process.env.OPENSCP_PACKAGED_EXE;
        application = await electron.launch({
          ...(executablePath ? { executablePath } : {}),
          args: [
            '--disable-gpu',
            '--in-process-gpu',
            `--user-data-dir=${userData}`,
            ...(process.env.OPENSCP_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
            ...(executablePath ? [] : [resolve('out/main/index.js')]),
          ],
          env: {
            ...process.env,
            OPENSCP_LOCAL_ROOT: root,
            OPENSCP_DISABLE_HARDWARE_ACCELERATION: '1',
          },
        });
        const page = await application.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const panel = page.getByTestId(`${side}-panel`);
        const other = page.getByTestId(`${side === 'left' ? 'right' : 'left'}-panel`);
        for (const localPanel of [panel, other]) {
          await expect(
            localPanel.getByRole('button', { name: 'Refresh', exact: true }),
          ).toBeEnabled();
          await localPanel.getByLabel('Current path').fill(root);
          await localPanel.getByLabel('Current path').press('Enter');
          await expect(
            localPanel.getByRole('row', { name: 'local.txt', exact: true }),
          ).toBeVisible();
        }
        const form = await newConnection(page, 's3');
        await form.getByLabel('Profile name').fill('Local S3 fixture');
        await form.getByLabel('Endpoint (blank for AWS)').fill(`http://127.0.0.1:${address.port}`);
        await form.getByLabel('Region', { exact: true }).fill('none');
        await form.getByLabel('Bucket (blank to list buckets)').fill(bucket);
        await form.getByLabel('Path-style addressing').check();
        await form.getByLabel('Access key ID', { exact: true }).fill('fixture-access-only');
        await form.getByLabel('Secret access key', { exact: true }).fill('fixture-secret-only');
        await finishProfile(page, form);
        await openConnection(page, side, 'Local S3 fixture');
        await expect(panel.getByLabel('Current path')).toHaveValue(`s3://${bucket}/`);
        if (!bucket) {
          await expect(
            panel.getByRole('button', { name: 'New directory', exact: true }),
          ).toBeDisabled();
          await panel.getByRole('row', { name: 'Open fixture-bucket', exact: true }).dblclick();
        }
        await expect(panel.getByRole('row', { name: 'remote.txt', exact: true })).toBeVisible();
        await expect(panel.getByRole('row', { name: 'local.txt', exact: true })).toHaveCount(0);
        await expect(other.getByRole('row', { name: 'local.txt', exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Drive or connection' })).toBeDisabled();
        await expect(
          panel.getByRole('button', { name: 'New directory', exact: true }),
        ).toBeEnabled();
        await panel.getByRole('row', { name: 'remote.txt', exact: true }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(panel.getByRole('row', { name: 'remote.txt', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        expect(requests).toContain('GET /fixture-bucket/');
        if (!bucket) expect(requests).toContain('GET /');
        expect(errors).toEqual([]);
        await page.screenshot({ path: test.info().outputPath('s3-connected.png') });
      } finally {
        await application?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        await rm(userData, { recursive: true, force: true });
      }
    });
  }
}
