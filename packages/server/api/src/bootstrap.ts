/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
// Uses require() instead of import to prevent hoisting, ensuring dotenv
// populates process.env before any module-level code reads it.
// quiet: dotenv 17 otherwise prints a plain-text "injecting env -- tip: <vendor ad>" line at
// every start, outside the JSON log stream. DOTENV_CONFIG_QUIET=false brings it back.
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env.dev'), quiet: true })
require('./main')
