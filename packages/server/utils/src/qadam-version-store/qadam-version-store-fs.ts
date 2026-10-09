import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { tryCatch } from '@aiqadam/shared'

// Filesystem helpers the store's reader and writer share. Internal to the store: not exported from
// the package, nor from the engine's reader entry.
export const qadamVersionStoreFs = {
    // The first `node_modules` at or above `dir`, which Node's upward lookup from a stored version
    // would reach.
    findNodeModulesAbove: async ({ dir }: { dir: string }): Promise<string | null> => {
        const candidates = ancestors({ dir }).map((ancestor) => path.join(ancestor, 'node_modules'))
        for (const candidate of candidates) {
            const found = await tryCatch(() => lstat(candidate))
            if (found.error === null) {
                return candidate
            }
        }
        return null
    },

    describeErrorCode: ({ error }: { error: unknown }): string => {
        return error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'
    },
}

function ancestors({ dir }: { dir: string }): string[] {
    const parent = path.dirname(dir)
    return parent === dir ? [dir] : [dir, ...ancestors({ dir: parent })]
}
