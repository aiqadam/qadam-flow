import {
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
} from '@aiqadam/shared'
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
// The rewrite is unconditional rather than "only if it reads 0.4.3": any older pin is already
// unresolvable against a single-version registry, so moving it forward can only turn a broken step
// into a working one. That also makes a second pass a no-op, which matters because these migrations
// run lazily on read against live user data.
export const migrateV24AiQadamVersion: Migration = {
    targetSchemaVersion: '24',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type !== FlowActionType.PIECE || step.settings.qadamName !== AI_QADAM_NAME) {
                return step
            }
            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamVersion: AI_QADAM_VERSION,
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '25',
        }
    },
}

export const AI_QADAM_NAME = '@aiqadam/qadam-ai'
export const AI_QADAM_VERSION = '0.4.4'
