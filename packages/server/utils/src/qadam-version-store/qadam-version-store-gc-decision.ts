import { isNil, isOfficialQadamName } from '@aiqadam/shared'
import { QadamVersionGcLedgerEntry } from './qadam-version-store-gc-ledger'
import { QadamVersionCoordinates } from './qadam-version-store-layout'

// The pure half of GC (ADR-0003 "GC", ADR-0004 "Store (#478)"): given what the instance already
// knows, which stored versions are still needed and which are candidates for collection. No I/O: the
// orchestrator (`qadam-version-store-gc.ts`, `packages/server/api`) gathers the sets from the store,
// the database and the ledger, and only it ever deletes anything.
export const qadamVersionStoreGcDecision = {
    // A stored version is protected when it is pinned by a flow version (`pinnedKeys`), when a pin
    // move left it as a step's revert target (`retainedKeys`), or when it is official and the
    // currently running image ships it (`imageVersions`, "name@version" strings). `pinnedKeys` and
    // `retainedKeys` use `coordinateKey` — built once per candidate, not recomputed per stored version.
    classify: ({ stored, pinnedKeys, imageVersions, retainedKeys }: ClassifyParams): ClassifyResult => {
        const protectedVersions: QadamVersionCoordinates[] = []
        const unreferenced: QadamVersionCoordinates[] = []
        for (const coordinates of stored) {
            const key = qadamVersionStoreGcDecision.coordinateKey(coordinates)
            const imageShipped = isNil(coordinates.platformId) && imageVersions.has(`${coordinates.name}@${coordinates.version}`)
            if (pinnedKeys.has(key) || retainedKeys.has(key) || imageShipped) {
                protectedVersions.push(coordinates)
            }
            else {
                unreferenced.push(coordinates)
            }
        }
        return { protectedVersions, unreferenced }
    },

    // Of the ledger's tracked entries (every version `classify` currently calls unreferenced, each
    // carrying when it was first seen that way), the ones that have stayed unreferenced for at least
    // `retentionDays`. A version pinned for a year and dropped an hour ago is tracked from `now`, not
    // from `storedAt`, so it still gets the full window.
    selectEligible: ({ entries, now, retentionDays }: SelectEligibleParams): QadamVersionGcLedgerEntry[] => {
        const cutoff = now.getTime() - retentionDays * MS_PER_DAY
        return entries.filter((entry) => new Date(entry.firstSeenUnreferencedAt).getTime() <= cutoff)
    },

    // A qadam's own identity decides its namespace, not the caller's: an official pin is always the
    // shared `null` namespace, whoever references it, and a custom pin is always its platform's.
    coordinateKey: ({ name, version, platformId }: { name: string, version: string, platformId: string | null }): string => {
        return tripleKey({ platformId: isOfficialQadamName(name) ? null : platformId, name, version })
    },
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function tripleKey({ platformId, name, version }: QadamVersionCoordinates): string {
    return JSON.stringify([platformId, name, version])
}

type ClassifyParams = {
    stored: QadamVersionCoordinates[]
    pinnedKeys: Set<string>
    imageVersions: Set<string>
    retainedKeys: Set<string>
}

type ClassifyResult = {
    protectedVersions: QadamVersionCoordinates[]
    unreferenced: QadamVersionCoordinates[]
}

type SelectEligibleParams = {
    entries: QadamVersionGcLedgerEntry[]
    now: Date
    retentionDays: number
}
