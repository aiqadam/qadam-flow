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

// `@aiqadam/qadam-ai` is republished a fourth time (#298): a step-level provider/name mismatch used
// to only `console.warn` and keep going for most callers, and #305 had just added a
// `requireProviderMatch` flag that failed loudly only when `run_agent`/`ask-ai` were about to attach
// a provider-specific web-search `ToolSet`. That flag is gone — every name-keyed decision downstream
// of the answering row (`openaiResponsesModel`, the AI-SDK `providerOptions` namespace key, web
// search) can silently diverge from it, not just the web-search tool set, so the mismatch is now
// rejected unconditionally, for every caller. No step input changes — this is a behaviour fix inside
// the qadam, not a new or altered prop.
//
// The republish is what needs this migration, for the same reason `migrate-v24-ai-qadam-version.ts`,
// `migrate-v25-ai-qadam-version-redo.ts` and `migrate-v27-ai-qadam-version-redo-2.ts` did: the
// bundled registry holds exactly one version per qadam name and `findExactVersion` resolves an exact
// pin `X` only inside `[X, next-patch(X))`, so a step left pinned at the previous version resolves
// to nothing and `flow-version-validator-util` throws `qadam_metadata_not_found`.
//
// Targets '28', the slot v27 (`migrate-v27-ai-qadam-version-redo-2.ts`, #305) stamps on every flow
// it touches — the next free slot, following the same one-migration-per-republish pattern.
//
// **A new file, not an edit to v27** — the chain only re-enters a migration whose
// `targetSchemaVersion` equals the version already in hand, and every flow v27 touches is stamped
// '28', so a flow that already passed through v27 can never re-enter it. Editing v27 would rescue
// nothing already past it and would silently retarget flows that have not reached '28' yet. The next
// republish after this one needs its own file too.
export const migrateV28AiQadamVersionRedo3: Migration = {
    targetSchemaVersion: '28',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const publishedVersion = await findPublishedAiQadamVersion()
        if (isNil(publishedVersion)) {
            return {
                ...flowVersion,
                schemaVersion: '29',
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
            schemaVersion: '29',
        }
    },
}

// Unconditional, as in v24, v25, v26 and v27: any older pin is already unresolvable against a
// single-version registry, so moving it forward can only turn a broken step into a working one, and
// a second pass is then a no-op. The one case where not rewriting is safer is a registry that holds
// no entry at all — a mid-reload read must not clear pins on its way past.
async function findPublishedAiQadamVersion(): Promise<string | undefined> {
    const log = system.globalLogger()
    const registry = await qadamMetadataService(log).registry({ release: apVersionUtil.getCurrentRelease() })
    return registry.find((entry) => entry.name === AI_QADAM_NAME)?.version
}
