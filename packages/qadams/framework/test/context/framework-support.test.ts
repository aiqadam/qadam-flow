import { describe, expect, it } from 'vitest'
import { ActionContext } from '../../src/lib/context'
import {
    ENGINE_CONTEXT_VERSIONS,
    FRAMEWORK_SUPPORT_TABLE,
    FrameworkContextVersion,
    PREDATES_CONTEXT_INFO,
} from '../../src/lib/context/framework-support'
import {
    backwardCompatabilityContextUtils,
    ContextVersion,
    LATEST_CONTEXT_VERSION,
} from '../../src/lib/context/versioning'

// Only what the shims read: the dispatcher is probed for whether it handles a version, not for
// what the adapted context does, so a full context would be noise.
const stubContext = {
    run: { id: 'run-id' },
    server: { publicUrl: 'http://localhost/' },
} as unknown as ActionContext

// Every value `qadam.getContextInfo?.().version` can hand the dispatcher, keyed in the vocabulary
// `ENGINE_CONTEXT_VERSIONS` and the support table use.
const DISPATCHER_INPUTS: { key: FrameworkContextVersion, contextVersion: ContextVersion | undefined }[] = [
    ...Object.values(ContextVersion).map((contextVersion) => ({ key: contextVersion, contextVersion })),
    { key: PREDATES_CONTEXT_INFO, contextVersion: undefined },
]

function dispatcherHandles(contextVersion: ContextVersion | undefined): boolean {
    try {
        return backwardCompatabilityContextUtils.makeActionContextBackwardCompatible({ context: stubContext, contextVersion }) !== undefined
    }
    catch {
        return false
    }
}

// The census (ADR-0002, #803) trusts `ENGINE_CONTEXT_VERSIONS` to say what this engine runs. A shim
// removed from the dispatcher but left in the list would hide every step that stops running; one
// listed but missing from the dispatcher would mark steps that still run.
describe('ENGINE_CONTEXT_VERSIONS', () => {
    it.each(DISPATCHER_INPUTS)('lists context $key exactly when the dispatcher handles it', ({ key, contextVersion }) => {
        expect(ENGINE_CONTEXT_VERSIONS.includes(key)).toBe(dispatcherHandles(contextVersion))
    })

    it('includes the latest context version', () => {
        expect(ENGINE_CONTEXT_VERSIONS).toContain(LATEST_CONTEXT_VERSION)
    })

    it('names only context versions the support table knows', () => {
        const known = new Set(FRAMEWORK_SUPPORT_TABLE.majors.flatMap((row) => row.contextVersions))
        expect(ENGINE_CONTEXT_VERSIONS.filter((version) => !known.has(version))).toEqual([])
    })
})
