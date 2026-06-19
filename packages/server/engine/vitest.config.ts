import path from 'path'
import { defineConfig } from 'vitest/config'

// Change CWD to repo root for compatibility with qadam-loader path resolution
const repoRoot = path.resolve(__dirname, '../../..')
process.chdir(repoRoot)

process.env.AP_EXECUTION_MODE = 'UNSANDBOXED'
process.env.AP_BASE_CODE_DIRECTORY = 'packages/server/engine/test/resources/codes'
process.env.AP_TEST_MODE = 'true'
process.env.AP_DEV_QADAMS = 'http,data-mapper,approval,webhook,delay'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    include: [path.resolve(__dirname, 'test/**/*.test.ts')],
  },
  resolve: {
    alias: {
      '@aiqadam/shared': path.resolve(__dirname, '../../../packages/shared/src/index.ts'),
      '@aiqadam/qadams-framework': path.resolve(__dirname, '../../../packages/qadams/framework/src/index.ts'),
      '@aiqadam/qadams-common': path.resolve(__dirname, '../../../packages/qadams/common/src/index.ts'),
    },
  },
})
