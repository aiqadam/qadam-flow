import { apVersionUtil } from '@aiqadam/server-utils'
import {
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { qadamMetadataService } from '../../../qadams/metadata/qadam-metadata-service'
import { Migration } from '.'

// `@aiqadam/qadam-ai` is republished because its two provider resolvers now accept a provider row
// id (`AgentProviderModel.providerId`) as well as a provider name. On its own that needs no data
// change — the field is optional and absent everywhere until something writes it.
//
// The republish is what needs this migration. The bundled registry holds exactly one version per
// qadam name, and `findExactVersion` resolves an exact pin `X` only inside `[X, next-patch(X))`.
// So the moment the package moves off the version stored in a step, that step resolves to nothing
// and `flow-version-validator-util` throws `qadam_metadata_not_found` on the next read. Rewriting
// the pin is the same remedy `migrate-v15-agent-provider-model.ts` used for the same reason.
//
// The target version is read from the live registry rather than written down here, which costs the
// purity `migrate-v19-strip-piece-version-wildcards.ts` and `migrate-v12-fix-piece-version.ts`
// already spend for the same lookup. A constant would be wrong twice over. It would be a live bug:
// these run lazily on read, so a flow still sitting at schemaVersion 20 a year and three republishes
// from now would be rewritten to a version the registry no longer holds — stranded by the very
// migration meant to rescue it. And it would be a trap: a constant that must equal the published
// version invites the next author to bump it, which restores any drift guard to green while doing
// nothing at all.
//
// Nothing about that last point is fixed by reading the registry, so state it plainly: **a future
// republish of `@aiqadam/qadam-ai` needs a NEW migration.** Every flow this one touches is stamped
// schemaVersion '25' afterwards and can never re-enter a migration targeting '24'. Editing this
// file will not carry those pins forward.
//
// `platformId` is deliberately not resolved. `filterQadamBasedOnType` admits an OFFICIAL qadam
// under any platform and `@aiqadam/qadam-ai` is one, so passing it would only cost this migration
// two queries per flow read to reach the same entry.
export const migrateV24AiQadamVersion: Migration = {
    targetSchemaVersion: '24',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const publishedVersion = await findPublishedAiQadamVersion()
        if (isNil(publishedVersion)) {
            return {
                ...flowVersion,
                schemaVersion: '25',
            }
        }

        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type !== FlowActionType.PIECE || step.settings.qadamName !== AI_QADAM_NAME) {
                return step
            }
            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamVersion: publishedVersion,
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '25',
        }
    },
}

// The rewrite is unconditional rather than "only if it reads the version before this one": any
// older pin is already unresolvable against a single-version registry, so moving it forward can
// only turn a broken step into a working one. That also makes a second pass a no-op.
//
// Leaving the pin alone when the registry has no entry is the one case where not rewriting is
// safer. A step pinned at nothing is broken either way, and a flow whose registry is mid-reload
// should not have its pins cleared on the way past.
async function findPublishedAiQadamVersion(): Promise<string | undefined> {
    const log = system.globalLogger()
    const registry = await qadamMetadataService(log).registry({ release: apVersionUtil.getCurrentRelease() })
    return registry.find((entry) => entry.name === AI_QADAM_NAME)?.version
}

export const AI_QADAM_NAME = '@aiqadam/qadam-ai'
