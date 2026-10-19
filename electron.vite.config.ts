import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { loadEnv } from 'vite';

const sharedAlias = resolve('src/shared');

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'OPENSCP_');
  return {
    main: {
      define: {
        __OPENSCP_YANDEX_CLIENT_ID__: JSON.stringify(
          environment.OPENSCP_YANDEX_CLIENT_ID?.trim() ?? '',
        ),
      },
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': sharedAlias,
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
      resolve: {
        alias: {
          '@shared': sharedAlias,
        },
      },
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': sharedAlias,
        },
      },
      plugins: [react()],
    },
  };
});
