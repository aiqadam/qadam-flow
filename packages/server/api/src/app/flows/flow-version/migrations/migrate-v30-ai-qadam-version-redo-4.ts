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

// `@aiqadam/qadam-ai` is republished a fifth time (#284/#323): `ai-sdk.ts` now rejects a stored
// `resourceName`/`region` pair that could move the AI SDK host to something other than what was
// validated, closing a host-validation gap. No step input changes — this is a behaviour fix inside
// the qadam, not a new or altered prop.
//
// The republish is what needs this migration, for the same reason `migrate-v24-ai-qadam-version.ts`,
// `migrate-v25-ai-qadam-version-redo.ts`, `migrate-v27-ai-qadam-version-redo-2.ts` and
// `migrate-v28-ai-qadam-version-redo-3.ts` did: the bundled registry holds exactly one version per
// qadam name and `findExactVersion` resolves an exact pin `X` only inside `[X, next-patch(X))`, so a
// step left pinned at the previous version resolves to nothing and `flow-version-validator-util`
// throws `qadam_metadata_not_found`.
//
// Targets '30', the slot v29 (`migrate-v29-agent-tool-metadata-qadam-rebrand.ts`) stamps on every
// flow it touches — the next free slot, following the same one-migration-per-republish pattern.
//
// **A new file, not an edit to v28 or v29** — the chain only re-enters a migration whose
// `targetSchemaVersion` equals the version already in hand, and every flow v29 touches is stamped
// '30', so a flow that already passed through v29 can never re-enter it. Editing v28 or v29 would
// rescue nothing already past them and would silently retarget flows that have not reached '30' yet.
// The next republish after this one needs its own file too.
export const migrateV30AiQadamVersionRedo4: Migration = {
    targetSchemaVersion: '30',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const publishedVersion = await findPublishedAiQadamVersion()
        if (isNil(publishedVersion)) {
            return {
                ...flowVersion,
                schemaVersion: '31',
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
            schemaVersion: '31',
        }
    },
}

// Unconditional, as in v24, v25, v27 and v28: any older pin is already unresolvable against a
// single-version registry, so moving it forward can only turn a broken step into a working one, and
// a second pass is then a no-op. The one case where not rewriting is safer is a registry that holds
// no entry at all — a mid-reload read must not clear pins on its way past.
async function findPublishedAiQadamVersion(): Promise<string | undefined> {
    const log = system.globalLogger()
    const registry = await qadamMetadataService(log).registry({ release: apVersionUtil.getCurrentRelease() })
    return registry.find((entry) => entry.name === AI_QADAM_NAME)?.version
}
