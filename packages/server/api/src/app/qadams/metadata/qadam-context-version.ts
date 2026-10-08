import { ContextVersion } from '@aiqadam/qadams-framework'

// Persisted for a qadam that reports no context version — it predates `getContextInfo`, so the
// engine runs it through the oldest shim (`case undefined` in the framework's `versioning.ts`).
// Kept distinct from NULL, which means the context version is not known (ADR-0002).
export const NO_CONTEXT_INFO = 'NONE'

export const qadamContextVersion = {
    fromContextInfo,
}

// `contextInfo` arrives from the engine, which read it off the qadam's own code, so its shape is
// not trusted. Only what `qadam-executor.ts` would turn into a known shim is stored: no version at
// all is NONE, a known `ContextVersion` is itself, and anything else — `null`, which the executor
// would fail on, or a version this server does not know — is unknown (NULL).
function fromContextInfo(contextInfo: unknown): QadamContextVersion | null {
    if (contextInfo === undefined) {
        return NO_CONTEXT_INFO
    }
    if (typeof contextInfo !== 'object' || contextInfo === null) {
        return null
    }
    if (!('version' in contextInfo) || contextInfo.version === undefined) {
        return NO_CONTEXT_INFO
    }
    return isContextVersion(contextInfo.version) ? contextInfo.version : null
}

function isContextVersion(value: unknown): value is ContextVersion {
    return Object.values<unknown>(ContextVersion).includes(value)
}

export type QadamContextVersion = ContextVersion | typeof NO_CONTEXT_INFO
