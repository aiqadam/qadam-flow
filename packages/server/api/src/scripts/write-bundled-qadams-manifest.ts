/* eslint-disable no-console */
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { system } from '../app/helper/system/system'
import { bundledQadamsManifest } from '../app/qadams/metadata/utils/bundled-qadams-manifest'
import { fileQadamsUtils } from '../app/qadams/metadata/utils/file-qadams-utils'

// #598: run once by the Dockerfile, in the run stage after the production install, so the manifest
// is built by the app's own scan code against the exact tree and node_modules the app reads at run
// time. The qadams root is an argument rather than the working directory, so the Dockerfile says
// where it writes. Never run it in a dev tree: a manifest there would go stale on the next build
// (the read side rejects a version-bumped dist, but not a rebuild at the same version).
async function main(): Promise<void> {
    const rootArgument = process.argv[2]
    if (isNil(rootArgument)) {
        fail('[bundledQadamsManifest] usage: write-bundled-qadams-manifest.js <qadams root>')
    }
    const qadamsRoot = path.resolve(rootArgument)
    const log = system.globalLogger()
    // Translations are always kept, whatever the flag says now: the read side drops them when it is
    // off, so turning it on later needs no rebuild.
    const { data: qadams, error: scanError } = await tryCatch(() => fileQadamsUtils(log).loadAllDistQadamsMetadata({ qadamsRoot, loadTranslations: true }))
    if (scanError) {
        fail(scanError)
    }
    // An empty catalogue means the qadam build did not run. Fail the image build rather than ship
    // it, and write nothing: an empty manifest is rejected on read anyway.
    if (qadams.length === 0) {
        fail(`[bundledQadamsManifest] no bundled qadams loaded under ${qadamsRoot}`)
    }
    const { data: count, error: writeError } = await tryCatch(() => bundledQadamsManifest.write({ qadamsRoot, qadams }))
    if (writeError) {
        fail(writeError)
    }
    console.log(`[bundledQadamsManifest] wrote ${count} qadams to the manifest`)
    // Explicit, because the 238 qadam modules this just required may hold the event loop open.
    process.exit(0)
}

function fail(reason: unknown): never {
    console.error(reason)
    process.exit(1)
}

void main()
