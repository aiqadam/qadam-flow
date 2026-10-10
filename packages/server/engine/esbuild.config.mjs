import * as esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outputPath = path.resolve(__dirname, '../../../dist/packages/engine/main.js')
const outdir = path.resolve(__dirname, '../../../dist/packages/engine')

const watch = process.argv.includes('--watch')

fs.rmSync(outdir, { recursive: true, force: true })

const buildOptions = {
    entryPoints: [path.resolve(__dirname, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: outputPath,
    format: 'cjs',
    sourcemap: true,
    minify: !watch,
    metafile: true,
    treeShaking: true,
    alias: {
        '@aiqadam/shared': path.resolve(__dirname, '../../shared/src'),
        '@aiqadam/pieces-framework': path.resolve(__dirname, '../../pieces/framework/src'),
        '@aiqadam/pieces-common': path.resolve(__dirname, '../../pieces/common/src'),
        // The store's reader only, from source, not the server-utils package (#779).
        '@aiqadam/server-utils/qadam-version-store-reader': path.resolve(__dirname, '../utils/src/qadam-version-store/reader.ts'),
        // The pin fallback's caret rule, shared with the API (#808).
        '@aiqadam/server-utils/qadam-pin-fallback-decision': path.resolve(__dirname, '../utils/src/qadam-pin-fallback-decision.ts'),
    },
    external: ['isolated-vm', 'utf-8-validate', 'bufferutil'],
    plugins: [
        {
            name: 'engine-rebuild-logger',
            setup(build) {
                let startedAt = 0
                build.onStart(() => {
                    startedAt = Date.now()
                    console.log('[engine] rebuilding…')
                })
                build.onEnd((result) => {
                    if (result.metafile) {
                        fs.writeFileSync(outputPath + '.meta.json', JSON.stringify(result.metafile))
                    }
                    const errors = result.errors?.length ?? 0
                    if (errors > 0) {
                        console.log(`[engine] rebuild failed with ${errors} error(s)`)
                    } else {
                        console.log(`[engine] rebuild done in ${Date.now() - startedAt}ms`)
                    }
                })
            },
        },
    ],
}

if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.rebuild()
    await ctx.watch()
} else {
    await esbuild.build(buildOptions)
}
