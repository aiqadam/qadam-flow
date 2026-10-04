import { defineConfig } from 'eslint/config'
import { serverConfigs } from '../../tools/eslint/server.mjs'

export default defineConfig(
    serverConfigs.shared({ tsconfigRootDir: import.meta.dirname }),
)
