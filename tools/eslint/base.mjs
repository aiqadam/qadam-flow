import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import unusedImports from 'eslint-plugin-unused-imports'
import tseslint from 'typescript-eslint'

const TS_FILES = ['**/*.ts', '**/*.tsx']
const JS_FILES = ['**/*.js', '**/*.jsx']
const SCRIPT_FILES = [...TS_FILES, ...JS_FILES]
const LODASH_PATTERNS = ['lodash', 'lodash/*']

// typescript-eslint 8 flipped `caughtErrors` to 'all'; 'none' keeps the 7.x behaviour so
// the flat-config migration does not change what lint reports. Tightening it is a separate decision.
const unusedVarsOptions = { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrors: 'none' }

export const baseConfigs = {
    /** Former root `.eslintrc.json`: base rules plus the lodash ban and the stray-semicolon rule. */
    root: () => defineConfig(
        {
            files: SCRIPT_FILES,
            rules: {
                'no-restricted-imports': ['error', { patterns: LODASH_PATTERNS }],
            },
        },
        typescriptRecommended({ unusedVarsSeverity: 'warn' }),
        {
            files: [...TS_FILES, ...JS_FILES],
            plugins: { '@stylistic': stylistic },
            rules: {
                '@stylistic/no-extra-semi': 'error',
            },
        },
    ),
    /** Former `.eslintrc.base.json`: what `web` and the qadams that opted out of the lodash ban start from. */
    base: () => defineConfig(
        typescriptRecommended({ unusedVarsSeverity: 'warn' }),
    ),
    /** Server packages report unused imports and variables as errors. */
    serverUnused: () => defineConfig({
        files: TS_FILES,
        plugins: { 'unused-imports': unusedImports },
        rules: {
            'unused-imports/no-unused-imports': 'error',
            '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
        },
    }),
    unusedVarsOptions,
    lodashPatterns: LODASH_PATTERNS,
    tsFiles: TS_FILES,
    scriptFiles: SCRIPT_FILES,
}

function typescriptRecommended({ unusedVarsSeverity }) {
    return {
        files: TS_FILES,
        extends: [tseslint.configs.recommended],
        plugins: { 'unused-imports': unusedImports },
        rules: {
            'unused-imports/no-unused-imports': 'warn',
            '@typescript-eslint/no-unused-vars': [unusedVarsSeverity, unusedVarsOptions],
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    }
}
