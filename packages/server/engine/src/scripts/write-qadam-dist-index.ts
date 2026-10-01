import path from 'path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { qadamDistIndex } from '../lib/helper/qadam-dist-index'

// #419: run once by the Dockerfile after the qadams are built, so the image carries
// `packages/qadams/dist-index.json` and no engine process has to walk the qadam tree. The qadams
// root is an argument rather than the working directory, so the Dockerfile says where it writes.
// Never run it in a dev tree: a manifest there would go stale on the next qadam build.
async function main(): Promise<void> {
    const rootArgument = process.argv[2]
    if (isNil(rootArgument)) {
        console.error('[qadamDistIndex] usage: write-qadam-dist-index.ts <qadams root>')
        process.exit(1)
    }
    const qadamsRoot = path.resolve(rootArgument)
    const { data: count, error } = await tryCatch(() => qadamDistIndex.writeManifest({ qadamsRoot }))
    if (error) {
        console.error(error)
        process.exit(1)
    }
    // An empty index means the qadam build did not run; fail the image build rather than ship it.
    if (count === 0) {
        console.error(`[qadamDistIndex] no built qadams under ${qadamsRoot}`)
        process.exit(1)
    }
    console.log(`[qadamDistIndex] wrote ${count} entries to the manifest`)
}

void main()
