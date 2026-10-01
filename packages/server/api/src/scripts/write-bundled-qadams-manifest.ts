/* eslint-disable no-console */
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { system } from '../app/helper/system/system'
import { bundledQadamsManifest } from '../app/qadams/metadata/utils/bundled-qadams-manifest'

// #598: run once by the Dockerfile, in the run stage after the production install, so the manifest
// is built by the app's own scan code against the exact tree and node_modules the app reads at run
// time. The qadams root is an argument rather than the working directory, so the Dockerfile says
// where it writes. Never run it in a dev tree: a manifest there would go stale on the next build
// (the read side rejects a dist rebuilt at a new version or added later, but not a rebuild at the
// same version).
async function main(): Promise<void> {
    const rootArgument = process.argv[2]
    if (isNil(rootArgument)) {
        fail('[bundledQadamsManifest] usage: write-bundled-qadams-manifest.js <qadams root>')
    }
    const qadamsRoot = path.resolve(rootArgument)
    const { data: result, error } = await tryCatch(() => bundledQadamsManifest.writeFromScan({ qadamsRoot, log: system.globalLogger() }))
    if (error) {
        fail(error)
    }
    switch (result.status) {
        // The qadam build did not run. Fail the image build rather than ship it.
        case 'empty':
            fail(`[bundledQadamsManifest] no bundled qadams loaded under ${qadamsRoot}`)
            break
        // A dist that does not load in the image is a broken image, and it would be missing from
        // the catalogue for the image's whole life. The scan's own warning above names the error.
        case 'partial':
            fail(`[bundledQadamsManifest] ${result.skipped.length} built qadam(s) failed to load, refusing a partial manifest: ${result.skipped.join(', ')}`)
            break
        case 'written':
            console.log(`[bundledQadamsManifest] wrote ${result.count} qadams to the manifest`)
            break
    }
    // Explicit, because the 238 qadam modules this just required may hold the event loop open.
    process.exit(0)
}

function fail(reason: unknown): never {
    console.error(reason)
    process.exit(1)
}

void main()
