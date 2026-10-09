import { QadamVersionReadStatus, qadamVersionStore, QadamVersionStoreLogger, QadamVersionStoreReader } from '@aiqadam/server-utils/qadam-version-store'
import { isNil } from '@aiqadam/shared'
import { qadamPlatformModules } from './qadam-platform-modules'

// ADR-0003: an official step pinned to `name@version` runs that version's own code from the qadam
// version store. The worker hands this engine the store's root in `AP_QADAM_VERSION_STORE_PATH`
// once it has opened the store itself (the forked execution modes only, #779); without it, or when
// the store does not hold the version, the loader falls back to what it did before the store.
export const qadamVersionStoreResolver = {
    // The entry point of the official `name@version` in the store, or null.
    findOfficialEntryPoint: async ({ name, version }: FindOfficialEntryPointParams): Promise<string | null> => {
        const store = await getStore()
        if (isNil(store)) {
            return null
        }
        const result = await store.read({ coordinates: { platformId: null, name, version } })
        switch (result.status) {
            case QadamVersionReadStatus.PRESENT:
                return result.version.entryPointPath
            case QadamVersionReadStatus.ABSENT:
            case QadamVersionReadStatus.INVALID_COORDINATES:
                return null
            default:
                warnOnce({
                    key: `${name}@${version}`,
                    line: `[qadamVersionStore] The stored version cannot be used, loading the image's build instead ${JSON.stringify({ qadam: `${name}@${version}`, status: result.status, reason: result.reason })}`,
                })
                return null
        }
    },
}

// Opened once per root for the life of the process: a stored version is never overwritten, so
// nothing read here goes stale.
const openedStores = new Map<string, Promise<QadamVersionStoreReader | null>>()
const warned = new Set<string>()

// `read` writes nothing, and only writes log.
const SILENT_STORE_LOG: QadamVersionStoreLogger = {
    info: () => undefined,
    warn: () => undefined,
}

function getStore(): Promise<QadamVersionStoreReader | null> {
    const root = process.env.AP_QADAM_VERSION_STORE_PATH
    if (isNil(root) || root.length === 0) {
        return Promise.resolve(null)
    }
    const existing = openedStores.get(root)
    if (!isNil(existing)) {
        return existing
    }
    const opening = openStore({ root })
    openedStores.set(root, opening)
    return opening
}

async function openStore({ root }: { root: string }): Promise<QadamVersionStoreReader | null> {
    const opened = await qadamVersionStore.openForReading({ root, log: SILENT_STORE_LOG })
    if (!opened.ok) {
        warnOnce({ key: 'unavailable', line: `[qadamVersionStore] The qadam version store is unavailable to this engine, loading the image's builds ${JSON.stringify({ reason: opened.reason })}` })
        return null
    }
    // Before any version is loaded from the store, never after: a stored version must not see a
    // single module the platform does not provide.
    const guarded = qadamPlatformModules.guard({ storeRoot: opened.reader.root })
    if (!guarded.ok) {
        warnOnce({ key: 'unguarded', line: `[qadamVersionStore] The qadam version store is unavailable to this engine, loading the image's builds ${JSON.stringify({ reason: guarded.reason })}` })
        return null
    }
    return opened.reader
}

// Through the job's console, like the dist index's rejected-manifest line: the job that first hit
// the problem is the one whose log should say why. Store reasons name no path.
function warnOnce({ key, line }: { key: string, line: string }): void {
    if (warned.has(key)) {
        return
    }
    warned.add(key)
    console.warn(line)
}

type FindOfficialEntryPointParams = {
    name: string
    version: string
}
