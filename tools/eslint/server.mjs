import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import importX from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'
import { baseConfigs } from './base.mjs'
import { safeHttpRules } from './safe-http-rules.mjs'

const { tsFiles, scriptFiles, lodashPatterns, unusedVarsOptions } = baseConfigs

// `@aiqadam/server-utils/qadam-version-store-reader` and `.../qadam-pin-fallback-decision` exist only
// through the engine's esbuild and vitest aliases (#779, #808). `tsconfig.base.json` maps them for
// every package, so anywhere else they would type-check and then fail at run time; the engine's own
// config replaces this rule.
const ENGINE_ONLY_SERVER_UTILS_SUBPATHS = {
    group: ['@aiqadam/server-utils/*'],
    message: 'Import @aiqadam/server-utils from its root. Its subpaths are engine-only aliases that do not exist at run time here.',
}

export const serverConfigs = {
    /** Former `packages/server/.eslintrc.json`: the SSRF and PUT/PATCH invariants every server package inherits. */
    server: () => defineConfig(
        baseConfigs.root(),
        baseConfigs.serverUnused(),
        {
            files: scriptFiles,
            rules: {
                'no-restricted-imports': ['error', { patterns: [{ group: lodashPatterns }, ENGINE_ONLY_SERVER_UTILS_SUBPATHS], paths: safeHttpRules.restrictedImportPaths }],
                'no-restricted-syntax': ['error', ...safeHttpRules.ssrfSyntax, ...safeHttpRules.routeMethodSyntax],
            },
        },
    ),
    /**
     * Former `packages/server/api/.eslintrc.json`. Its `test/**` relaxation reached utils, engine, worker
     * and shared as well, because `@eslint/eslintrc` resolved an inherited override against the package
     * that extended it, so it lives here rather than in api's own config.
     */
    api: ({ tsconfigRootDir }) => defineConfig(
        serverConfigs.server(),
        {
            files: tsFiles,
            extends: [tseslint.configs.strict],
        },
        importX.flatConfigs.recommended,
        {
            files: ['**/*.ts', '**/*.js'],
            languageOptions: {
                parserOptions: {
                    project: ['tsconfig.*?.json'],
                    tsconfigRootDir,
                },
            },
            plugins: { '@stylistic': stylistic },
            rules: apiRules,
        },
        {
            files: ['test/**/*.ts'],
            rules: {
                '@typescript-eslint/no-explicit-any': 'off',
                '@typescript-eslint/no-dynamic-delete': 'off',
            },
        },
        {
            settings: {
                'import-x/resolver': {
                    typescript: { alwaysTryTypes: false },
                    node: true,
                },
            },
        },
    ),
    /** Former `packages/server/engine/.eslintrc.json`: the engine has its own SSRF defence, so the selectors are off. */
    engine: ({ tsconfigRootDir }) => defineConfig(
        serverConfigs.api({ tsconfigRootDir }),
        {
            files: ['**/*.ts', '**/*.js'],
            rules: { 'no-console': 'off' },
        },
        {
            files: scriptFiles,
            rules: {
                'no-restricted-imports': ['error', { patterns: lodashPatterns }],
                'no-restricted-syntax': 'off',
            },
        },
    ),
    /** Former `packages/server/utils/.eslintrc.json`: the wrapper itself and its fetch test are the only sanctioned exceptions. */
    utils: ({ tsconfigRootDir }) => defineConfig(
        serverConfigs.api({ tsconfigRootDir }),
        {
            files: ['test/safe-http-fetch.test.ts'],
            rules: {
                'no-restricted-syntax': ['error', ...safeHttpRules.safeHttpTestSyntax],
            },
        },
        {
            files: ['src/safe-http.ts'],
            rules: {
                'no-restricted-imports': ['error', { patterns: lodashPatterns }],
                'no-restricted-syntax': ['error', ...safeHttpRules.safeHttpFileSyntax],
            },
        },
    ),
    /** Former `packages/shared/.eslintrc.json`: shared sits on the api chain, so it carries the SSRF selectors too. */
    shared: ({ tsconfigRootDir }) => defineConfig(
        serverConfigs.api({ tsconfigRootDir }),
        {
            files: ['src/**/*.ts'],
            rules: {
                'no-restricted-properties': ['error', ...safeHttpRules.sharedRestrictedProperties],
            },
        },
    ),
}

// The formatting rules typescript-eslint 8 dropped (brace-style, indent, quotes, ...) live on
// as same-named rules in @stylistic with identical options. They are near-identical, not identical:
// indent and comma-dangle read a few multi-line constructs differently, and those sites were reflowed.
const apiRules = {
    'import-x/no-unresolved': 'off',
    // v4 cannot see type-only exports (e.g. `MutexInterface` from async-mutex); tsc already checks this.
    'import-x/named': 'off',
    'no-console': 'error',
    'object-shorthand': 'error',
    // v8 stopped treating `default` as covering the missing members of a union; v7 did.
    '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    '@stylistic/brace-style': ['error', 'stroustrup'],
    '@stylistic/comma-dangle': ['error', 'always-multiline'],
    // typescript-eslint's own indent rule never looked inside type argument lists; this one does.
    '@stylistic/indent': ['error', 4, { ignoredNodes: ['TSTypeParameterInstantiation'] }],
    '@stylistic/quotes': ['error', 'single'],
    '@stylistic/semi': ['error', 'never'],
    '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-redundant-type-constituents': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/adjacent-overload-signatures': 'error',
    '@stylistic/comma-spacing': 'error',
    '@stylistic/type-annotation-spacing': 'error',
    '@stylistic/block-spacing': 'error',
    '@stylistic/function-call-spacing': 'error',
    '@stylistic/key-spacing': 'error',
    '@stylistic/object-curly-spacing': ['error', 'always'],
    '@stylistic/space-before-blocks': 'error',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@stylistic/member-delimiter-style': ['error', {
        multiline: { delimiter: 'none' },
        singleline: { delimiter: 'comma', requireLast: false },
    }],
    '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
    '@stylistic/space-before-function-paren': ['error', {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always',
    }],
    '@stylistic/space-infix-ops': 'error',
    '@stylistic/keyword-spacing': 'error',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'warn',
    '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    'default-case-last': 'error',
    'import-x/no-duplicates': 'error',
    'import-x/order': ['error', { alphabetize: { order: 'asc' } }],
    'sort-imports': ['error', {
        ignoreCase: true,
        ignoreDeclarationSort: true,
        ignoreMemberSort: false,
        memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
        allowSeparatedGroups: false,
    }],
}
