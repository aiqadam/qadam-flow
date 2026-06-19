/**
 * Standalone Node entrypoint that loads a qadam's compiled JS and prints its
 * metadata as JSON on stdout. Invoked as a child process from
 * `qadam-script-utils.ts:loadQadamFromFolder` so that the qadam's
 * `require('@aiqadam/qadams-framework')` resolves via standard
 * node_modules lookup — matching the pinned framework inside the qadam's
 * package.json — instead of being intercepted by `tsconfig-paths/register`
 * in the parent script (which would redirect to the local workspace
 * framework and silently clobber `minimumSupportedRelease` via the floor
 * check in `Qadam`'s constructor).
 *
 * Usage: node load-qadam-metadata-child.mjs <qadamDistFolder>
 */

import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const folderPath = process.argv[2]
if (!folderPath) {
    console.error('[load-qadam-metadata-child] missing folder path argv')
    process.exit(2)
}

const entryPath = resolve(folderPath, 'src', 'index.js')
const require = createRequire(import.meta.url)
const module = require(entryPath)

let qadam = null
for (const exported of Object.values(module)) {
    if (exported !== null && exported !== undefined && exported.constructor?.name === 'Qadam') {
        qadam = exported
        break
    }
}

if (!qadam) {
    console.error(`[load-qadam-metadata-child] no Qadam export found in ${entryPath}`)
    process.exit(3)
}

const payload = {
    metadata: qadam.metadata(),
    minimumSupportedRelease: qadam.minimumSupportedRelease ?? null,
    maximumSupportedRelease: qadam.maximumSupportedRelease ?? null,
    authors: qadam.authors ?? [],
}

process.stdout.write(JSON.stringify(payload))
