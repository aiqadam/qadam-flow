import path from 'path'
import { defineConfig } from 'vitest/config'

// Change CWD to repo root for compatibility with qadam-loader path resolution
const repoRoot = path.resolve(__dirname, '../../..')
process.chdir(repoRoot)

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    include: [path.resolve(__dirname, 'test/**/*.test.ts')],
  },
  resolve: {
    alias: {
      'isolated-vm': path.resolve(__dirname, '__mocks__/isolated-vm.js'),
      '@aiqadam/shared': path.resolve(__dirname, '../../../packages/shared/src/index.ts'),
      '@aiqadam/qadams-framework': path.resolve(__dirname, '../../../packages/qadams/framework/src/index.ts'),
      '@aiqadam/qadams-common': path.resolve(__dirname, '../../../packages/qadams/common/src/index.ts'),
      '@aiqadam/server-utils': path.resolve(__dirname, '../../../packages/server/utils/src/index.ts'),

    },
  },
})
