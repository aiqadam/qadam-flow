import path from 'path'
import { qadamDistIndex } from '../lib/helper/qadam-dist-index'

// #419: run once by the Dockerfile after the qadams are built, from the repo root, so the image
// carries `packages/qadams/dist-index.json` and no engine process has to walk the qadam tree.
// Never run it in a dev tree: a manifest there would go stale on the next qadam build.
async function main(): Promise<void> {
    const qadamsRoot = path.resolve('packages/qadams')
    const count = await qadamDistIndex.writeManifest({ qadamsRoot })
    if (count === 0) {
        throw new Error(`No built qadams found under ${qadamsRoot}`)
    }
    console.log(`[qadamDistIndex] wrote ${count} entries to the manifest`)
}

main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
})
