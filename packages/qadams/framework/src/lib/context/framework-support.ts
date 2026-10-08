import supportTable from './framework-support-table.json'
import { ContextVersion } from './versioning'

// What a qadam that predates `getContextInfo()` reports, in the table's vocabulary.
export const PREDATES_CONTEXT_INFO = 'none'

// The context versions this engine runs: the latest one as it is, every older one through a shim
// in `makeActionContextBackwardCompatible` (versioning.ts). The framework-major census (ADR-0002,
// #803) marks a step whose pinned qadam needs a version missing here. Retiring a shim means
// removing its entry here in the same change: `test/context/framework-support.test.ts` fails while
// this list and the dispatcher disagree, and gate 8 (`tools/ci/check-framework-support.mjs`) fails
// while the support table says the retired major is still supported.
export const ENGINE_CONTEXT_VERSIONS: readonly FrameworkContextVersion[] = [
    ContextVersion.V2,
    ContextVersion.V1,
    PREDATES_CONTEXT_INFO,
]

// The framework support table of ADR-0002, the same file gate 8 (`tools/ci/check-framework-support.mjs`)
// checks. Gate 8 keeps its last row at the major of this package.
export const FRAMEWORK_SUPPORT_TABLE: FrameworkSupportTable = supportTable

export type FrameworkContextVersion = ContextVersion | typeof PREDATES_CONTEXT_INFO

export type FrameworkSupportTable = {
    majors: readonly FrameworkSupportRow[]
}

export type FrameworkSupportRow = {
    major: number
    // What a qadam built against this major reports; read as data, so not narrowed to known values.
    contextVersions: readonly string[]
    released: string | null
    successorReleased: string | null
}
