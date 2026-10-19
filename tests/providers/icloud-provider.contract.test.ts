// @vitest-environment node
import { createRemoteProviderPath } from '../../src/shared/models/provider-path';
import { startICloudFixture } from '../fixtures/icloud-harness';
import { runFileSystemProviderContractTests } from './provider-contract';

runFileSystemProviderContractTests('iCloud through rclone', async () => {
  const fixture = await startICloudFixture();
  return {
    provider: fixture.create(),
    root: createRemoteProviderPath('icloud', '/'),
    path: (...segments: readonly string[]) =>
      createRemoteProviderPath('icloud', `/${segments.join('/')}`),
    dispose: fixture.close,
  };
});
