import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import importPlugin from 'eslint-plugin-import'
import jestDom from 'eslint-plugin-jest-dom'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import testingLibrary from 'eslint-plugin-testing-library'
import unusedImports from 'eslint-plugin-unused-imports'
import vitest from 'eslint-plugin-vitest'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { baseConfigs } from './base.mjs'
import { prettierConfigs } from './prettier.mjs'

const WEB_FILES = ['**/*.ts', '**/*.tsx']

// react-hooks 7 ships the React Compiler rules in `recommended`. They flag ~170 existing sites, so
// they report as warnings until those are worked through; rules-of-hooks stays an error as before.
const reactCompilerRules = Object.fromEntries(
    Object.keys(reactHooks.configs.flat.recommended.rules)
        .filter((name) => name !== 'react-hooks/rules-of-hooks' && name !== 'react-hooks/exhaustive-deps')
        .map((name) => [name, 'warn']),
)

export const webConfigs = {
    /** Former `packages/web/.eslintrc.json`. */
    web: () => defineConfig(
        baseConfigs.base(),
        {
            files: WEB_FILES,
            extends: [
                js.configs.recommended,
                importPlugin.flatConfigs.errors,
                importPlugin.flatConfigs.warnings,
                importPlugin.flatConfigs.typescript,
                tseslint.configs.recommended,
                react.configs.flat.recommended,
                reactHooks.configs.flat.recommended,
                prettierConfigs.recommended(),
                testingLibrary.configs['flat/react'],
                jestDom.configs['flat/recommended'],
                vitest.configs.recommended,
            ],
            languageOptions: {
                parser: tseslint.parser,
                globals: { ...globals.browser, ...globals.node },
            },
            plugins: { 'unused-imports': unusedImports },
            settings: {
                react: { version: 'detect' },
                'import/resolver': {
                    typescript: {},
                    alias: {
                        map: [['@', './src']],
                        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
                    },
                },
            },
            rules: webRules,
        },
        {
            files: ['src/components/**/*.{ts,tsx}'],
            rules: { 'react/prop-types': 'off' },
        },
    ),
}

const webRules = {
    ...reactCompilerRules,
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'import/no-restricted-paths': ['error', {
        zones: [
            // enforce unidirectional codebase:
            // e.g. src/app can import from src/features but not the other way around
            {
                target: './src/features',
                from: './src/app',
            },
            {
                target: ['./src/components', './src/hooks', './src/lib', './src/types', './src/utils'],
                from: ['./src/features', './src/app'],
                except: ['../app/query-client.ts'],
            },
        ],
    }],
    'import/no-cycle': 'off',
    'linebreak-style': ['error', 'unix'],
    'react/prop-types': 'error',
    'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
    }],
    'import/default': 'off',
    'import/no-named-as-default-member': 'off',
    'import/no-named-as-default': 'off',
    'react/react-in-jsx-scope': 'off',
    'unused-imports/no-unused-imports': 'error',
    '@typescript-eslint/no-unused-vars': ['error', baseConfigs.unusedVarsOptions],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/indent': 'off',
    'prettier/prettier': ['error', {
        singleQuote: true,
        trailingComma: 'all',
        printWidth: 80,
        tabWidth: 2,
        useTabs: false,
        jsxBracketSameLine: false,
    }],
}
