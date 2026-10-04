import { defineConfig } from 'eslint/config'
import { serverConfigs } from '../../../tools/eslint/server.mjs'

export default defineConfig(
    serverConfigs.api({ tsconfigRootDir: import.meta.dirname }),
    serverConfigs.apiTestRelaxations(),
)
