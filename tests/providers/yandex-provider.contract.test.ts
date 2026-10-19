// @vitest-environment node
import { createYandexProviderPath } from '../../src/shared/models/provider-path';
import { createYandexHarness } from '../fixtures/yandex-harness';
import { runFileSystemProviderContractTests } from './provider-contract';

runFileSystemProviderContractTests('Yandex Disk REST', async () => {
  const harness = await createYandexHarness();
  await harness.authorize();
  return {
    provider: harness.provider(),
    root: createYandexProviderPath('/'),
    path: (...segments) => createYandexProviderPath(`/${segments.join('/')}`),
    dispose: harness.close,
  };
});
