import { qadamVersionParser } from '@aiqadam/shared'

// ADR-0004 "Following `main`": the instance setting that decides what the start-up pass does to a
// pin whose version is available. The values are the raw environment strings, so a comparison at a
// call site reads the way the setting is documented.
const POLICIES = ['follow', 'pin'] as const

export const qadamSnapshotPolicy = {
    values: POLICIES,

    // `follow` moves an available pin to the newest build the image ships inside its caret range;
    // `pin` never rewrites an available pin. The default follows the running platform version: a
    // `-main.<n>` snapshot is a build from `main`, whose qadams are the snapshots `follow` exists to
    // track, while a release instance pins. An unreadable version pins too: it is not a `-main` build.
    resolveDefault: ({ version }: { version: string }): QadamSnapshotPolicy => {
        const parsed = qadamVersionParser.parse({ version })
        return parsed !== null && parsed.snapshot !== null ? 'follow' : 'pin'
    },

    // Only the exact `follow` value follows. A blank, unset or mistyped value pins, which is the
    // safe side: nothing rewrites an available pin unless the operator asked for it.
    isFollow: ({ value }: { value: string | undefined }): boolean => value === 'follow',
}

export type QadamSnapshotPolicy = typeof POLICIES[number]
