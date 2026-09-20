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
    splitPin({ pin }: { pin: string }): { name: string, version: string } {
        const separator = pin.lastIndexOf('@')
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

    // Batch form for a validation/reporting caller: resolves every distinct pin once and treats a
    // resolution failure the same as a miss (`false`) rather than aborting the whole batch — the
    // shape both `ap_validate_flow` and `ap_flow_structure` want, and what the heal migration reads
    // to decide which pins are candidates for replacement.
    async resolvePins({ pins, platformId, log }: {
        pins: string[]
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<Map<string, boolean>> {
        return new Map(await Promise.all(pins.map(async (pin): Promise<[string, boolean]> => {
            const { name, version } = qadamPinUtil.splitPin({ pin })
            const { data: resolvedVersion } = await tryCatch(() => qadamPinUtil.resolvePinVersion({ name, version, platformId, log }))
            return [pin, !isNil(resolvedVersion)]
        })))
    },

    // Heal path only: given a qadam name whose pinned version no longer resolves, find a version
    // of that same qadam the registry can currently serve — mirrors what `migrate-v30`'s
    // `findPublishedAiQadamVersion` does for one hardcoded name, generalized to any name. A
    // registry failure degrades to "no replacement found" rather than throwing.
    async findResolvableVersion({ name, platformId, log }: {
        name: string
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<string | undefined> {
        const { data: registry } = await tryCatch(() => qadamMetadataService(log).registry({
            release: apVersionUtil.getCurrentRelease(),
            platformId,
        }))
        return registry?.find(entry => entry.name === name)?.version
    },
}

export type QadamPinnedStep = Extract<Step, { settings: { qadamName: string, qadamVersion: string } }>
