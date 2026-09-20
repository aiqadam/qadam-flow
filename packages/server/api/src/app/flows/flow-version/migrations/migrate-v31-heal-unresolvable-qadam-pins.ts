import {
    flowStructureUtil,
    FlowVersion,
    isNil,
    tryCatch,
    unique,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { system } from '../../../helper/system/system'
import { projectService } from '../../../project/project-service'
import { qadamPinUtil } from '../../../qadams/metadata/qadam-pin-util'
import { flowService } from '../../flow/flow.service'
import { Migration } from '.'

// #432/#474 step 0: an image upgrade can drop the exact qadam version a step is pinned to, and
// #424's bundled fallback deliberately does not cross a caret boundary for a 0.x qadam (see the
// comment on `satisfiesRequestedRange` in `qadam-metadata-service.ts` — #435 rejected widening it).
// That leaves the flow LOCKED, valid and ENABLED, failing only when something next provisions it.
// This migration is the one-off heal: for any qadam name (not a hardcoded list — the five
// `migrate-v24`..`migrate-v30` files this repo already has are the failure mode this exists to
// end), if a step's pin no longer resolves, repoint it at whatever version of that same qadam the
// registry can currently serve. A pin that still resolves is left untouched, byte for byte — that
// is the safety property the whole migration rests on.
//
// Runs exactly once per flow version, like every migration in this chain (`migrations/index.ts`
// only re-enters a migration whose `targetSchemaVersion` equals the version already in hand), so
// this is a one-off heal, not an ongoing repair: a qadam whose registry entry disappears again
// after this runs is not caught a second time by this file.
export const migrateV31HealUnresolvableQadamPins: Migration = {
    targetSchemaVersion: '31',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const log = system.globalLogger()
        const platformId = await resolvePlatformId({ flowId: flowVersion.flowId, log })
        // `migrateFlowVersionTemplate` calls the chain with no context and, on the template-import
        // path, a `flowId` that may not exist in the database at all — there is nothing to derive a
        // platform from, and guessing would risk filtering a platform's own custom qadams out of
        // the registry lookup below. Leaving every pin untouched is the only safe move here.
        if (isNil(platformId)) {
            return { ...flowVersion, schemaVersion: '32' }
        }

        const qadamSteps = qadamPinUtil.getQadamSteps({ trigger: flowVersion.trigger })
        if (qadamSteps.length === 0) {
            return { ...flowVersion, schemaVersion: '32' }
        }

        const pins = qadamPinUtil.collectDistinctPins({ steps: qadamSteps })
        const resolutions = await qadamPinUtil.resolvePins({ pins, platformId, log })

        const unresolvedNames = unique(qadamSteps
            .filter(step => resolutions.get(qadamPinUtil.pinOf({ step })) === false)
            .map(step => step.settings.qadamName))
        if (unresolvedNames.length === 0) {
            return { ...flowVersion, schemaVersion: '32' }
        }

        const replacementByName = await resolveReplacements({ names: unresolvedNames, platformId, log })
        if (replacementByName.size === 0) {
            return { ...flowVersion, schemaVersion: '32' }
        }

        const stepNameToReplacementVersion: Record<string, string> = {}
        for (const step of qadamSteps) {
            const isUnresolved = resolutions.get(qadamPinUtil.pinOf({ step })) === false
            const replacement = replacementByName.get(step.settings.qadamName)
            if (isUnresolved && !isNil(replacement)) {
                stepNameToReplacementVersion[step.name] = replacement
            }
        }

        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            const replacement = stepNameToReplacementVersion[step.name]
            if (isNil(replacement)) {
                return step
            }
            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamVersion: replacement,
                },
            }
        })

        return {
            ...newFlowVersion,
            schemaVersion: '32',
        }
    },
}

// Mirrors `migrate-v19-strip-piece-version-wildcards.ts`'s own platform resolution rather than
// trusting `MigrationContext.projectId`, so the two migrations degrade identically for the same
// caller. Unlike v19, every step here is wrapped in `tryCatch`: v19 accepts a migration-wide throw
// on a missing platform (`getPlatformId` throws when the project row is gone), but this migration
// must not — `flow-version-migration.service.ts` pages on-call on any throw from the chain, and a
// missing platform is exactly the "cannot determine" case this migration is required to degrade on.
async function resolvePlatformId({ flowId, log }: { flowId: string, log: FastifyBaseLogger }): Promise<string | undefined> {
    const { data: flow } = await tryCatch(() => flowService(log).getOneById(flowId))
    if (isNil(flow)) {
        return undefined
    }
    const { data: platformId } = await tryCatch(() => projectService(log).getPlatformId(flow.projectId))
    return platformId ?? undefined
}

async function resolveReplacements({ names, platformId, log }: {
    names: string[]
    platformId: string
    log: FastifyBaseLogger
}): Promise<Map<string, string>> {
    const entries = await Promise.all(names.map(async (name): Promise<[string, string | undefined]> => {
        const replacement = await qadamPinUtil.findResolvableVersion({ name, platformId, log })
        return [name, replacement]
    }))
    return new Map(entries.filter((entry): entry is [string, string] => !isNil(entry[1])))
}
