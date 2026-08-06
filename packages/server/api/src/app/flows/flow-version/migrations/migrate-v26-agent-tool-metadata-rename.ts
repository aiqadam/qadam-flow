import {
    AgentQadamProps,
    AgentToolType,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { Migration } from '.'

// v7 and v8 wrote agent PIECE tool metadata under `qadamMetadata` (migrate-v7-agents-to-flow-version.ts,
// migrate-v8-agent-tools.ts). The shared schema has only ever declared the field as `pieceMetadata`
// (`AgentQadamTool.pieceMetadata` in @aiqadam/shared), #246 moved every engine read to that name, and
// #256 fixed v16/v23's *read* of the same name for the tool-name rename — but no migration has ever
// renamed the stored field itself. A flow that passed through v7/v8 and stopped there, or that simply
// was never rewritten by something that happens to replace the whole tool object, still carries
// `qadamMetadata` today at any schemaVersion, and throws a `TypeError` the moment the engine reads
// `tool.pieceMetadata.qadamName` (#295).
//
// v16 and v23 do not fix this on their own: both only *read* `pieceMetadata` to decide a tool's new
// name, so a tool still shaped as `qadamMetadata` fails their `!= null` guard and falls through
// untouched — the same silent-skip failure mode as #247, just one field over. This migration is the
// rename that was missing, so v16/v23 having already run (or never running again) does not matter —
// once a tool carries `pieceMetadata`, the engine read works regardless of `toolName`.
//
// Deliberately not scoped to `qadamName === '@aiqadam/qadam-ai' && actionName === 'run_agent'`, the
// filter v16/v23 use: v7/v8 never rewrite a step's `qadamName` away from the legacy
// `@aiqadam/qadam-agent` they match on, and no migration in this chain (v9-v25) renames it either —
// so a v7/v8-shaped step would fail that filter the same way it fails the `pieceMetadata` guard in
// v16/v23, and this migration would silently skip exactly the tools it exists to fix. `agentTools` is
// otherwise only ever written under an agent's `run_agent` step regardless of which package name that
// step carries, so keying off the input field's presence reaches the legacy cohort without depending
// on a package-name assumption this codebase's own migration history doesn't support.
//
// Idempotent by construction: a tool that already has `pieceMetadata` (the normal case for every
// install that never touched v7/v8) is left untouched, and a tool with neither field is left alone
// rather than guessed at.
export const migrateV26AgentToolMetadataRename: Migration = {
    targetSchemaVersion: '26',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type !== FlowActionType.PIECE) {
                return step
            }

            const input = step.settings.input as Record<string, unknown>
            const tools = input[AgentQadamProps.AGENT_TOOLS] as AgentToolInput[] | undefined
            if (isNil(tools)) {
                return step
            }

            return {
                ...step,
                settings: {
                    ...step.settings,
                    input: {
                        ...input,
                        [AgentQadamProps.AGENT_TOOLS]: tools.map(renameLegacyToolMetadata),
                    },
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '27',
        }
    },
}

function renameLegacyToolMetadata(tool: AgentToolInput): AgentToolInput {
    if (tool.type !== AgentToolType.PIECE || !isNil(tool.pieceMetadata) || isNil(tool.qadamMetadata)) {
        return tool
    }
    const { qadamMetadata, ...rest } = tool
    return {
        ...rest,
        pieceMetadata: qadamMetadata,
    }
}

type AgentToolMetadata = { qadamName: string, qadamVersion: string, actionName: string, [key: string]: unknown }

type AgentToolInput = {
    type: string
    toolName: string
    pieceMetadata?: AgentToolMetadata
    qadamMetadata?: AgentToolMetadata
    [key: string]: unknown
}
