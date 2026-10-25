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
        opening ??= openAndCache({ log })
        return opening
    },
}

let cachedStore: QadamVersionStore | null = null
let opening: Promise<OpenResult> | null = null

async function openAndCache({ log }: { log: FastifyBaseLogger }): Promise<OpenResult> {
    const result = await qadamVersionStore.open({ root: system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_PATH), log })
    opening = null
    if (result.ok) {
        cachedStore = result.store
    }
    return result
}

type OpenResult = Awaited<ReturnType<typeof qadamVersionStore.open>>
