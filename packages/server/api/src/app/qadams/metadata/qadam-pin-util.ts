import { apVersionUtil } from '@aiqadam/server-utils'
import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    isNil,
    Step,
    tryCatch,
    unique,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { qadamMetadataService } from './qadam-metadata-service'
import { isNewerVersion } from './utils'

// A step keeps the exact qadam version it was configured with, and three call sites each needed
// their own copy of "walk the steps, find the pinned ones, ask qadamMetadataService whether the
// pin still resolves": `ap-validate-flow.ts`'s pre-publish check, `migrate-v19`'s wildcard strip,
// and the throwing prop-validator in `flow-version-validator-util.ts`. This collects the
// steps/pins/resolution shape the first two share; `getOrThrow` in the validator needs the
// resolved piece's `actions`/`triggers`/`auth` for prop validation, not just a resolvability
// answer, so it is left calling `qadamMetadataService` directly (#474).
export const qadamPinUtil = {
    getQadamSteps({ trigger }: { trigger: Step }): QadamPinnedStep[] {
        return flowStructureUtil.getAllSteps(trigger)
            .filter((step): step is QadamPinnedStep =>
                (step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
                && !isNil(step.settings.qadamName)
                && !isNil(step.settings.qadamVersion))
    },

    pinOf({ step }: { step: QadamPinnedStep }): string {
        return `${step.settings.qadamName}@${step.settings.qadamVersion}`
    },

    // Scoped names carry their own `@`, so the pin is split on the LAST `@` rather than the first.
    // Every caller today feeds this `pinOf`'s own output, which always contains one, but this is an
    // exported util — a pin with no `@` at all must not silently drop its last character into
    // `name` (`lastIndexOf` returning `-1` would otherwise do exactly that via `slice(0, -1)`).
    splitPin({ pin }: { pin: string }): { name: string, version: string } {
        const separator = pin.lastIndexOf('@')
        if (separator === -1) {
            return { name: pin, version: '' }
        }
        return { name: pin.slice(0, separator), version: pin.slice(separator + 1) }
    },

    // Distinct (name, version) pairs only: a flow with twelve steps on one pin should cost one
    // resolution, not twelve, and the answer cannot differ between them.
    collectDistinctPins({ steps }: { steps: QadamPinnedStep[] }): string[] {
        return unique(steps.map(step => qadamPinUtil.pinOf({ step })))
    },

    // The raw, throwing primitive: mirrors `qadamMetadataService.get()` itself — a miss returns
    // `undefined`, a real failure (DB down, disk read) propagates. A caller that must degrade
    // instead of failing (a live MCP tool, the heal migration) wraps this in `tryCatch`; a caller
    // that already accepts a migration-wide throw (the wildcard-stripping migration, which never
    // wrapped its own `get()` call either) can call it exactly as it called `get()` before.
    async resolvePinVersion({ name, version, platformId, log }: {
        name: string
        version: string
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<string | undefined> {
        const metadata = await qadamMetadataService(log).get({ platformId, name, version })
        return metadata?.version
    },

    // Tri-state, deliberately: `true` is resolved, `false` is a definite miss (the lookup
    // completed and found nothing), `undefined` is "the lookup errored" — a statement timeout,
    // pool exhaustion, a failover, an `ECONNRESET`. Collapsing the last two into one `false` is
    // safe for the two read-only reporting callers (`ap_validate_flow`, `ap_flow_structure`
    // already treat "anything but `true`" as "flag it", so a report reads an error the same as a
    // miss, which is the right default for a human/agent-facing report). It is NOT safe for the
    // heal migration, which uses a `false` to *persist a rewrite* — a transient error must never
    // read as "definitely dead" there, or a healthy LOCKED flow gets its pin silently changed
    // during exactly the DB-pressure window (an image upgrade) this migration is most likely to
    // run in. Callers that must not conflate the two check `=== false` explicitly.
    async resolvePins({ pins, platformId, log }: {
        pins: string[]
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<Map<string, boolean | undefined>> {
        return new Map(await Promise.all(pins.map(async (pin): Promise<[string, boolean | undefined]> => {
            const { name, version } = qadamPinUtil.splitPin({ pin })
            const { data: resolvedVersion, error } = await tryCatch(() => qadamPinUtil.resolvePinVersion({ name, version, platformId, log }))
            if (!isNil(error)) {
                return [pin, undefined]
            }
            return [pin, !isNil(resolvedVersion)]
        })))
    },

    // Heal path only: given a qadam name whose pinned version no longer resolves, find a version
    // of that same qadam the registry can currently serve — mirrors what `migrate-v30`'s
    // `findPublishedAiQadamVersion` does for one hardcoded name, generalized to any name. A
    // registry failure degrades to "no replacement found" rather than throwing.
    //
    // Picks the single HIGHEST version among the candidates, not the first match: `registry()`
    // (unlike `list()`) never runs its result through `lastVersionOfEachQadam` — it returns every
    // matching row `filterRegistry` lets through, undeduped and in whatever order
    // `fetchRegistryFromDB`'s `ORDER BY`-less `SELECT` happens to hand back (in practice, insertion
    // order — the oldest first). That was invisible for the one bundled name v30 hardcoded, because
    // a bundled qadam only ever has one registry row. A CUSTOM platform qadam accumulates one row
    // per installed version, so an unsorted `.find()` could silently downgrade a step to an older
    // release the moment its previously-pinned version is deleted. "Highest available" is the same
    // direction every hand-written `migrate-v24`..`migrate-v30` file already moves a dead pin — this
    // generalizes that convention rather than picking the version nearest the dead pin, which would
    // need its own justification for stopping short of the latest available fix.
    async findResolvableVersion({ name, platformId, log }: {
        name: string
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<string | undefined> {
        const { data: registry } = await tryCatch(() => qadamMetadataService(log).registry({
            release: apVersionUtil.getCurrentRelease(),
            platformId,
        }))
        const candidates = (registry ?? []).filter(entry => entry.name === name)
        return candidates.reduce<string | undefined>(
            (best, entry) => (isNil(best) || isNewerVersion(entry.version, best) ? entry.version : best),
            undefined,
        )
    },
}

export type QadamPinnedStep = Extract<Step, { settings: { qadamName: string, qadamVersion: string } }>
