import path from 'path'
import { defineConfig } from 'vitest/config'

const repoRoot = path.resolve(__dirname, '../../../..')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The resource-bound tests feed the parser inputs that would exhaust any heap if a bound
    // regressed; a capped worker fails them fast instead of taking the machine down with it.
    // Together these flags put the worker's heap limit near 536 MiB.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=512', '--max-semi-space-size=8'],
      },
    },
  },
  resolve: {
    alias: {
      '@aiqadam/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
      '@aiqadam/qadams-framework': path.resolve(repoRoot, 'packages/qadams/framework/src/index.ts'),
      '@aiqadam/qadams-common': path.resolve(repoRoot, 'packages/qadams/common/src/index.ts'),
    },
  },
})
