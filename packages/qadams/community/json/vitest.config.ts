import path from 'path'
import { defineConfig } from 'vitest/config'

const repoRoot = path.resolve(__dirname, '../../../..')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@aiqadam/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
      '@aiqadam/qadams-framework': path.resolve(repoRoot, 'packages/qadams/framework/src/index.ts'),
      '@aiqadam/qadams-common': path.resolve(repoRoot, 'packages/qadams/common/src/index.ts'),
    },
  },
})
