import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: [path.resolve(__dirname, 'test/**/*.test.ts')],
    exclude: [path.resolve(__dirname, 'test/e2e/**')],
  },
  resolve: {
    alias: {
      '@aiqadam/shared': path.resolve(__dirname, '../../../packages/shared/src/index.ts'),
      '@aiqadam/qadams-framework': path.resolve(__dirname, '../../../packages/qadams/framework/src/index.ts'),
      '@aiqadam/server-utils': path.resolve(__dirname, '../../../packages/server/utils/src/index.ts'),
    },
  },
})
