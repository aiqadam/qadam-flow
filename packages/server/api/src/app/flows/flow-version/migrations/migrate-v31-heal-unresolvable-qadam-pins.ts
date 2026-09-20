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
        const logContext = { flowVersionId: flowVersion.id, flowId: flowVersion.flowId }

        // Checked before resolving a platform: every flow version in the fleet passes through this
        // migration exactly once (the `LATEST_FLOW_SCHEMA_VERSION` bump), and most have no pinned
        // qadam step at all — there is nothing to spend a `getOneById` + `getPlatformId` round trip
        // on for those, and this runs over the entire installed base at once, right after an image
        // upgrade, which is exactly when DB pressure is least welcome.
        const qadamSteps = qadamPinUtil.getQadamSteps({ trigger: flowVersion.trigger })
        if (qadamSteps.length === 0) {
            log.debug({ ...logContext, reason: 'no_qadam_steps' }, '[migrateV31HealUnresolvableQadamPins] no pinned qadam steps in this flow version — nothing to heal')
            return { ...flowVersion, schemaVersion: '32' }
        }

        const platformId = await resolvePlatformId({ flowId: flowVersion.flowId, log })
        // `migrateFlowVersionTemplate` calls the chain with no context and, on the template-import
        // path, a `flowId` that may not exist in the database at all — there is nothing to derive a
        // platform from, and guessing would risk filtering a platform's own custom qadams out of
        // the registry lookup below. Leaving every pin untouched is the only safe move here.
        //
        // This is a genuine degrade, not a no-op: the chain only re-enters a migration whose
        // `targetSchemaVersion` matches, so this flow version is now permanently stamped '32'
        // without ever having been checked. `log.warn` is the only trace of that left anywhere.
        if (isNil(platformId)) {
            log.warn({ ...logContext, reason: 'platform_undetermined' }, '[migrateV31HealUnresolvableQadamPins] could not resolve a platform for this flow version — leaving every qadam pin untouched')
            return { ...flowVersion, schemaVersion: '32' }
        }

        const pins = qadamPinUtil.collectDistinctPins({ steps: qadamSteps })
        const resolutions = await qadamPinUtil.resolvePins({ pins, platformId, log })

        // Strict `=== false`, not merely "not true": `resolvePins` is tri-state, and `undefined`
        // means the lookup errored rather than definitively missing. Treating an error the same as
        // a miss here would persist a rewrite to a step whose pin was actually fine — the one
        // failure mode this migration exists to avoid. This equality check is the safety property
        // the whole migration rests on; a pin that still resolves, or whose resolution merely
        // failed transiently, is left untouched, byte for byte.
        const unresolvedNames = unique(qadamSteps
            .filter(step => resolutions.get(qadamPinUtil.pinOf({ step })) === false)
            .map(step => step.settings.qadamName))
        if (unresolvedNames.length === 0) {
            // Not necessarily "every pin resolved" — a pin whose lookup merely errored also fails
            // this `=== false` filter, and is deliberately reported the same as a clean resolution
            // here: this path never heals anything, so there is nothing to get wrong either way.
            log.debug({ ...logContext, reason: 'no_definite_miss' }, '[migrateV31HealUnresolvableQadamPins] no pinned qadam version was confirmed unresolvable — nothing to heal')
            return { ...flowVersion, schemaVersion: '32' }
        }

        const replacementByName = await resolveReplacements({ names: unresolvedNames, platformId, log })
        if (replacementByName.size === 0) {
            log.warn({ ...logContext, reason: 'no_replacement_found', unresolvedNames }, '[migrateV31HealUnresolvableQadamPins] found unresolvable qadam pins but the registry has no replacement version for any of them — these pins remain broken')
            return { ...flowVersion, schemaVersion: '32' }
        }

        // A `Map`, not a `Record`: `transferFlow` below calls its callback for EVERY step, not only
        // the rewritten ones, and a step name is only checked against `STEP_NAME_REGEX`
        // (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`), which admits `constructor`, `toString`, `hasOwnProperty`,
        // `__proto__` — names that survive `ap_import_flow` verbatim. A bare `Record` index on one
        // of those reaches `Object.prototype` and would hand back a function (or, for `__proto__`,
        // an object) as the "replacement" version, which `isNil` happily lets through. Same idiom
        // as the `hasOwn`, not a bare index guard in `ap-validate-flow.ts`'s delay-unit lookup.
        const stepNameToReplacementVersion = new Map<string, string>()
        const rewrites: { stepName: string, qadamName: string, oldVersion: string, newVersion: string }[] = []
        for (const step of qadamSteps) {
            const isUnresolved = resolutions.get(qadamPinUtil.pinOf({ step })) === false
            const replacement = replacementByName.get(step.settings.qadamName)
            if (isUnresolved && !isNil(replacement)) {
                stepNameToReplacementVersion.set(step.name, replacement)
                rewrites.push({ stepName: step.name, qadamName: step.settings.qadamName, oldVersion: step.settings.qadamVersion, newVersion: replacement })
            }
        }

        if (rewrites.length === 0) {
            log.warn({ ...logContext, reason: 'no_replacement_found', unresolvedNames }, '[migrateV31HealUnresolvableQadamPins] found unresolvable qadam pins but no replacement matched any of their steps — these pins remain broken')
            return { ...flowVersion, schemaVersion: '32' }
        }
        log.info({ ...logContext, rewrites }, '[migrateV31HealUnresolvableQadamPins] repointed unresolvable qadam pins to a version the registry currently serves')

        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            const replacement = stepNameToReplacementVersion.get(step.name)
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
