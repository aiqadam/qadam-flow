import { defineConfig } from 'eslint/config'
import { serverConfigs } from '../../../tools/eslint/server.mjs'

export default defineConfig(
    serverConfigs.utils({ tsconfigRootDir: import.meta.dirname }),
)
