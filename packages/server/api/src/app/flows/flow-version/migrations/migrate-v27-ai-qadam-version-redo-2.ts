import { apVersionUtil } from '@aiqadam/server-utils'
import {
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { qadamMetadataService } from '../../../qadams/metadata/qadam-metadata-service'
import { AI_QADAM_NAME } from './migrate-v24-ai-qadam-version'
import { Migration } from '.'

// `@aiqadam/qadam-ai` is republished a third time (#305): a step-level provider/name mismatch used
// to only `console.warn` and keep going, even when `run_agent` or `ask-ai` were about to attach a
// provider-specific web-search `ToolSet` built from the stored name. Both actions now ask
// `createAIModel` to fail loudly on that mismatch whenever web search is enabled, rather than
// letting the resulting failure surface downstream with a message that names nothing. No step input
// changes — this is a behaviour fix inside the qadam, not a new or altered prop.
//
// The republish is what needs this migration, for the same reason `migrate-v24-ai-qadam-version.ts`
// and `migrate-v25-ai-qadam-version-redo.ts` did: the bundled registry holds exactly one version per
// qadam name and `findExactVersion` resolves an exact pin `X` only inside `[X, next-patch(X))`, so a
// step left pinned at the previous version resolves to nothing and `flow-version-validator-util`
// throws `qadam_metadata_not_found`.
//
// Targets '27', not '26': `migrate-v26-agent-tool-metadata-rename.ts` (#295/#316) claimed the '26'
// slot first and already stamps '27' on every flow it touches. This migration was originally written
// against '26' before that PR merged; rebasing onto it means re-targeting to the next free slot
// rather than colliding with an already-merged migration.
//
// **A new file, not an edit to v26** — the chain only re-enters a migration whose
// `targetSchemaVersion` equals the version already in hand, and every flow v26 touches is stamped
// '27', so a flow that already passed through v26 can never re-enter it. Editing v26 would rescue
// nothing already past it and would silently retarget flows that have not reached '27' yet. The next
// republish after this one needs its own file too.
export const migrateV27AiQadamVersionRedo2: Migration = {
    targetSchemaVersion: '27',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const publishedVersion = await findPublishedAiQadamVersion()
        if (isNil(publishedVersion)) {
            return {
                ...flowVersion,
                schemaVersion: '28',
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
            schemaVersion: '28',
        }
    },
}

// Unconditional, as in v24, v25 and v26: any older pin is already unresolvable against a
// single-version registry, so moving it forward can only turn a broken step into a working one, and
// a second pass is then a no-op. The one case where not rewriting is safer is a registry that holds
// no entry at all — a mid-reload read must not clear pins on its way past.
async function findPublishedAiQadamVersion(): Promise<string | undefined> {
    const log = system.globalLogger()
    const registry = await qadamMetadataService(log).registry({ release: apVersionUtil.getCurrentRelease() })
    return registry.find((entry) => entry.name === AI_QADAM_NAME)?.version
}
