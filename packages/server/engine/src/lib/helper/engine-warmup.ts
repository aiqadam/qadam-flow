import { createRequire } from 'module'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { qadamDistIndex } from './qadam-dist-index'

// #419: what the first job in a fresh engine process pays before its first step can run, done
// while the engine sits idle instead. The worker turns this on only for the sandbox a prewarm starts
// before its slot polls: that process outlives its first job and every flow loads at least its
// trigger's qadam, so none of it is wasted work. Both halves were measured on QA: the dist index is the first `resolveMs`
// (270–540 ms without the image manifest), and the framework's own module graph (framework, shared,
// zod) is most of the first `importMs` (0.6–0.9 s, `sharedDepsAlreadyLoaded: false`).
export const engineWarmup = {
    isEnabled: (): boolean => process.env.AP_ENGINE_WARMUP === 'true',

    run: async ({ write }: RunParams): Promise<void> => {
        const indexStart = performance.now()
        const { data: distIndex, error } = await tryCatch(() => qadamDistIndex.get({ refresh: false, warn: write }))
        const distIndexMs = performance.now() - indexStart
        if (error) {
            write(`[engineWarmup] skipped ${JSON.stringify({ reason: 'dist index unavailable', error: error.message })}`)
            return
        }
        const anchor = distIndex.values().next().value?.indexPath
        const depsStart = performance.now()
        const loads = isNil(anchor) ? [] : SHARED_QADAM_DEPS.map((dependency) => requireFrom({ anchor, dependency }))
        write(`[engineWarmup] done ${JSON.stringify({
            distIndexMs: roundMs(distIndexMs),
            qadams: distIndex.size,
            sharedDepsMs: roundMs(performance.now() - depsStart),
            sharedDeps: loads.filter((load) => isNil(load.failure)).map((load) => load.dependency),
            failedDeps: loads.flatMap((load) => isNil(load.failure) ? [] : [{ name: load.dependency, reason: load.failure }]),
        })}`)
    },
}

// What a qadam's own dist `require`s from `node_modules`, as opposed to the copies inside the engine
// bundle. Every bundled qadam's local symlinks realpath to the same files, and the CJS cache is keyed
// by realpath, so loading them once through any qadam's directory serves all of them.
const SHARED_QADAM_DEPS = ['@aiqadam/qadams-framework', '@aiqadam/qadams-common']

// Resolved from a bundled qadam's directory: the engine runs as one bundled file from a cache copy
// with no `node_modules` beside it, so a bare name does not resolve from the engine's own location
// (the same reason the #419 Phase 0 `sharedDepsAlreadyLoaded` probe anchors on the qadam).
function requireFrom({ anchor, dependency }: RequireFromParams): DependencyLoad {
    const { error } = tryCatchSync(() => createRequire(anchor)(dependency))
    // The first line only: Node appends the whole require stack after it.
    return { dependency, failure: isNil(error) ? null : error.message.split('\n')[0] }
}

function roundMs(value: number): number {
    return Math.round(value * 10) / 10
}

type RunParams = {
    // Where the warmup's one line goes. Not the engine's patched console: that also feeds the
    // notify channel, so a line written while the first job runs would land in its logs.
    write: (line: string) => void
}

type RequireFromParams = {
    anchor: string
    dependency: string
}

type DependencyLoad = {
    dependency: string
    failure: string | null
}
