import path from 'path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@aiqadam/qadams-framework': path.resolve(
        __dirname,
        '../../packages/qadams/framework/src',
      ),
      '@aiqadam/shared': path.resolve(
        __dirname,
        '../../packages/shared/src',
      ),
    },
  },
});
