import { ContextVersion } from '@aiqadam/qadams-framework'

// Persisted for a qadam that reports no context version — it predates `getContextInfo`, so the
// engine runs it through the oldest shim (`case undefined` in the framework's `versioning.ts`).
export const NO_CONTEXT_INFO = 'NONE'

// Persisted for a qadam that loaded but reported something no shim on this server matches. It is a
// measurement, not a gap: kept apart from NULL (never measured) so the backfill never loads it again.
export const UNRECOGNISED_CONTEXT_VERSION = 'UNRECOGNISED'

export const qadamContextVersion = {
    fromContextInfo,
}

// `contextInfo` arrives from the engine, which read it off the qadam's own code, so its shape is
// not trusted. No version at all is NONE, a known `ContextVersion` is itself, and anything else —
// `null`, which the executor would fail on, or a version this server does not know — is
// UNRECOGNISED. For the ADR-0002 census every value except V2 still needs the old contract.
function fromContextInfo(contextInfo: unknown): QadamContextVersion {
    if (contextInfo === undefined) {
        return NO_CONTEXT_INFO
    }
    if (typeof contextInfo !== 'object' || contextInfo === null) {
        return UNRECOGNISED_CONTEXT_VERSION
    }
    if (!('version' in contextInfo) || contextInfo.version === undefined) {
        return NO_CONTEXT_INFO
    }
    return isContextVersion(contextInfo.version) ? contextInfo.version : UNRECOGNISED_CONTEXT_VERSION
}

function isContextVersion(value: unknown): value is ContextVersion {
    return Object.values<unknown>(ContextVersion).includes(value)
}

export type QadamContextVersion = ContextVersion | typeof NO_CONTEXT_INFO | typeof UNRECOGNISED_CONTEXT_VERSION
