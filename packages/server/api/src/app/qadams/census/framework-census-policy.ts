import {
    ContextVersion,
    ENGINE_CONTEXT_VERSIONS,
    FRAMEWORK_SUPPORT_TABLE,
    FrameworkContextVersion,
    LATEST_CONTEXT_VERSION,
    PREDATES_CONTEXT_INFO,
} from '@aiqadam/qadams-framework'
import { isNil } from '@aiqadam/shared'
import { NO_CONTEXT_INFO, QadamContextVersion } from '../metadata/qadam-context-version'

// ADR-0002's rules for the census, in one place: what this release runs, what an official qadam's
// framework major means, and what an unknown context version counts as. Everything that reads the
// engine's supported set goes through `engineContextVersions()`, so a test can stand in for a
// release that has retired a shim.
export const frameworkCensusPolicy = {
    engineContextVersions(): readonly FrameworkContextVersion[] {
        return ENGINE_CONTEXT_VERSIONS
    },

    // Gate 8 keeps the table's last row at the major of the framework this tree builds, which is
    // the major every bundled official qadam is compiled against (`workspace:*`).
    currentFrameworkMajor(): number {
        return Math.max(...FRAMEWORK_SUPPORT_TABLE.majors.map((row) => row.major))
    },

    // Before `qadams-framework@1.0.0` every official qadam built in this repository reports V2 —
    // ADR-0002 states it for the 0.x row, whose own `contextVersions` also cover the custom qadams
    // that row's shims exist for. From 1.0.0 on a major has exactly one context version.
    contextOfOfficialMajor({ major }: { major: number }): FrameworkContextVersion | null {
        if (major === 0) {
            return ContextVersion.V2
        }
        const row = FRAMEWORK_SUPPORT_TABLE.majors.find((candidate) => candidate.major === major)
        if (isNil(row) || row.contextVersions.length !== 1) {
            return null
        }
        return toFrameworkContextVersion(row.contextVersions[0])
    },

    // `qadam_metadata.contextVersion` (#802): NONE is a qadam that predates `getContextInfo`, NULL
    // is unknown.
    fromStoredContextVersion({ value }: { value: QadamContextVersion | null | undefined }): FrameworkContextVersion | null {
        if (isNil(value)) {
            return null
        }
        return value === NO_CONTEXT_INFO ? PREDATES_CONTEXT_INFO : toFrameworkContextVersion(value)
    },

    // True once this release has dropped a context version the support table lists. Until then no
    // step can be unsupported, so per-request surfaces skip the lookup.
    hasRetiredContextVersion(): boolean {
        return frameworkCensusPolicy.retiredContextVersions().length > 0
    },

    // The context versions the support table knows that this engine no longer runs. Empty until a
    // release retires a shim, so a surface can skip pin resolution entirely while it is empty.
    retiredContextVersions(): FrameworkContextVersion[] {
        const engine = frameworkCensusPolicy.engineContextVersions()
        return knownContextVersions().filter((version) => !engine.includes(version))
    },

    // An unknown context version counts as still needing the old contract (ADR-0002): it is
    // reported as running on a shim while every shim is still here, and as unsupported once any is
    // gone.
    statusOf({ contextVersion }: { contextVersion: FrameworkContextVersion | null }): FrameworkCensusStatus {
        if (isNil(contextVersion)) {
            return frameworkCensusPolicy.hasRetiredContextVersion() ? 'unsupported' : 'legacy'
        }
        if (!frameworkCensusPolicy.engineContextVersions().includes(contextVersion)) {
            return 'unsupported'
        }
        return contextVersion === LATEST_CONTEXT_VERSION ? 'current' : 'legacy'
    },
}

function knownContextVersions(): FrameworkContextVersion[] {
    return FRAMEWORK_SUPPORT_TABLE.majors
        .flatMap((row) => row.contextVersions)
        .map(toFrameworkContextVersion)
        .filter((version): version is FrameworkContextVersion => !isNil(version))
}

function toFrameworkContextVersion(value: string): FrameworkContextVersion | null {
    if (value === PREDATES_CONTEXT_INFO) {
        return PREDATES_CONTEXT_INFO
    }
    return Object.values(ContextVersion).find((version) => version === value) ?? null
}

// `current`: the latest context, no shim involved. `legacy`: runs through a context shim, so it
// stops running when that shim is retired (an unknown context counts here). `unsupported`: this
// release no longer runs it.
export type FrameworkCensusStatus = 'current' | 'legacy' | 'unsupported'
