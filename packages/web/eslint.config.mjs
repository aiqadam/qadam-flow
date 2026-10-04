import { defineConfig } from 'eslint/config'
import { webConfigs } from '../../tools/eslint/web.mjs'

export default defineConfig(
    webConfigs.web(),
)
