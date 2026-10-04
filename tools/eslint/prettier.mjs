import { defineConfig } from 'eslint/config'
import prettierConfig from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'

/**
 * Equivalent of the legacy `plugin:prettier/recommended`: eslint-config-prettier switches off every
 * rule that fights the formatter, then `prettier/prettier` reports what Prettier would change.
 */
export const prettierConfigs = {
    recommended: ({ files, options } = {}) => defineConfig({
        ...(files ? { files } : {}),
        plugins: { prettier: prettierPlugin },
        rules: {
            ...prettierConfig.rules,
            'arrow-body-style': 'off',
            'prefer-arrow-callback': 'off',
            'prettier/prettier': options ? ['error', options] : 'error',
        },
    }),
}
