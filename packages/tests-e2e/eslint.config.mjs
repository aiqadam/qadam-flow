import { defineConfig } from 'eslint/config'
import { baseConfigs } from '../../tools/eslint/base.mjs'

export default defineConfig(
    baseConfigs.root(),
)
