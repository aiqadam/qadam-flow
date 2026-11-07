import { qadamVersionStore, QadamVersionStore } from '@aiqadam/server-utils'
import { FastifyBaseLogger } from 'fastify'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'

// `qadamVersionStore.open` is the write side: it creates the store's directories, probes the
// filesystem for case sensitivity and sweeps stale staging/trash leftovers (see its own comment).
// `qadamVersionStoreSeeding` pays that cost once, at boot. A caller that needs to WRITE outside
// boot — the fetcher, here — would otherwise repeat it on every publish or import; this memoizes
// the open across the whole process instead, the same store object `qadamVersionStoreSeeding`
// would have opened for itself.
//
// Only a successful open is cached. A failed one (the volume not mounted yet, a permissions
// problem) is retried on the next call rather than remembered forever, because the condition that
// failed it can clear without a restart.
export const qadamVersionStoreAccess = {
    open: ({ log }: { log: FastifyBaseLogger }): Promise<OpenResult> => {
        if (cachedStore !== null) {
            return Promise.resolve({ ok: true, store: cachedStore })
        }
        // `.finally` chained onto the call, not a `try`/`finally` inside `openAndCache` itself: a
        // rejection synchronous enough to land before `openAndCache`'s own first `await` (reading its
        // config throws) would otherwise run an inner `finally`'s reset BEFORE this `??=` assignment
        // even executes, so the assignment would immediately overwrite `opening` with the rejected
        // promise anyway. `.finally` always defers to a microtask, even on an already-settled promise,
        // so the reset here is guaranteed to run after the assignment below, for every failure shape.
        opening ??= openAndCache({ log }).finally(() => {
            opening = null
        })
        return opening
    },
}

let cachedStore: QadamVersionStore | null = null
let opening: Promise<OpenResult> | null = null

async function openAndCache({ log }: { log: FastifyBaseLogger }): Promise<OpenResult> {
    const result = await qadamVersionStore.open({ root: system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_PATH), log })
    if (result.ok) {
        cachedStore = result.store
    }
    return result
}

type OpenResult = Awaited<ReturnType<typeof qadamVersionStore.open>>
