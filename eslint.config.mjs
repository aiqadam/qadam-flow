// Nothing is linted from the repository root: every package owns its eslint.config.mjs, and its
// `lint` script runs from the package directory so ESLint finds that one first.
export default [
    { ignores: ['**/*'] },
]
