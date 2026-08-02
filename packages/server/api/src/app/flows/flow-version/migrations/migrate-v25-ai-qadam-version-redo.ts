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

// `@aiqadam/qadam-ai` is republished again: the five community AI actions (`ask-ai`,
// `classify-text`, `generate-image`, `extract-structured-data`, `summarize-text`) gained an
// optional `providerId` so a step can name one provider *row* rather than a provider type. The
// field is optional and absent everywhere until something writes it, so no step input changes here
// — and none should, because absent already means "the row the provider name resolves to" and
// writing an id would pick a row on the operator's behalf.
//
// The republish is what needs this migration, for the same reason `migrate-v24-ai-qadam-version.ts`
// existed: the bundled registry holds exactly one version per qadam name and `findExactVersion`
// resolves an exact pin `X` only inside `[X, next-patch(X))`, so a step left pinned at the previous
// version resolves to nothing and `flow-version-validator-util` throws `qadam_metadata_not_found`.
//
// **This is a new file rather than an edit to v24, and that is not a stylistic choice.** v24 stamps
// every flow it touches with schemaVersion '25'; the chain only runs a migration whose
// `targetSchemaVersion` equals the version in hand, so those flows can never re-enter it. Editing
// v24 would rescue nothing and would silently retarget flows that have not reached it yet. v24's
// own header says so, and the same pairing already exists in this directory — v15 repeats v14, and
// v23 repeats v16. Each migration is a frozen record of one republish; the next one gets its own
// file too.
//
// The target version is read from the live registry rather than written down here, for the reason
// v24 gives at length: these run lazily on read, so a constant would strand a flow that arrives
// after a later republish, and a constant that must equal the published version invites the next
// author to bump it in place — which turns any drift guard green while doing nothing.
export const migrateV25AiQadamVersionRedo: Migration = {
    targetSchemaVersion: '25',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const publishedVersion = await findPublishedAiQadamVersion()
        if (isNil(publishedVersion)) {
            return {
                ...flowVersion,
                schemaVersion: '26',
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
            schemaVersion: '26',
        }
    },
}

// Unconditional, as in v24: any older pin is already unresolvable against a single-version
// registry, so moving it forward can only turn a broken step into a working one, and a second pass
// is then a no-op. The one case where not rewriting is safer is a registry that holds no entry at
// all — a mid-reload read must not clear pins on its way past.
async function findPublishedAiQadamVersion(): Promise<string | undefined> {
    const log = system.globalLogger()
    const registry = await qadamMetadataService(log).registry({ release: apVersionUtil.getCurrentRelease() })
    return registry.find((entry) => entry.name === AI_QADAM_NAME)?.version
}
