import path from 'path'
import { defineConfig } from 'vitest/config'

// Three levels, not four: this file sits at packages/qadams/common. The previous `../../../..`
// resolved above the repository, so every alias below silently pointed at a path that does not
// exist — harmless only for as long as no test imported one.
const repoRoot = path.resolve(__dirname, '../../..')

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
