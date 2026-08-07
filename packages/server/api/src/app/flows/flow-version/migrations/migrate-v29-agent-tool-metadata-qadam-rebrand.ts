import {
    AgentQadamProps,
    AgentToolType,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { Migration } from '.'

// #246 renamed every engine read of an agent PIECE tool's metadata from `qadamMetadata` to
// `pieceMetadata`, and migrate-v26-agent-tool-metadata-rename.ts (#295/#316) rightly propagated
// that into stored data for the v7/v8-originated flows still carrying the pre-#246 key — at the
// time both landed, `pieceMetadata` was the live, correct name. It should not have been: every
// other metadata construct in this codebase is `qadam*` (`qadamMetadataService`, `qadamName`,
// `qadamVersion`, `AgentQadamToolMetadata` itself) — `pieceMetadata` was the one field that quietly
// carried upstream Activepieces' original "piece" terminology forward instead of this fork's
// "qadam" naming. This migration is the rebrand-back: `AgentQadamTool.qadamMetadata` is now the
// schema's declared field name (see @aiqadam/shared), engine/qadam/web read and write sites were
// updated alongside it, and this backfills every flow already sitting on the interim `pieceMetadata`
// key so old and newly-created flows agree again.
//
// Deliberately NOT an edit to migrate-v26: v26's own logic (legacy `qadamMetadata` -> the
// then-current `pieceMetadata`) was correct for what it targeted and is left exactly as it was —
// the precedent for "the convention moved again, write a new file" is migrate-v27/v28 redoing
// migrate-v24/v25's AI-qadam-version bump three times rather than ever editing an earlier one.
// migrate-v16/v23's own reads of `pieceMetadata` are untouched for the same reason: they are
// describing the schema shape as it stood at their point in the chain's history, not this
// migration's post-rebrand convention.
//
// Unconditional rename, no "does qadamMetadata already exist" guard the way v26 needed one: by the
// time any flow reaches schemaVersion '29', it has already passed through v26 (or never needed to),
// so at most one of the two keys can be present here — never both, unlike the legacy/current overlap
// v26 had to disambiguate.
export const migrateV29AgentToolMetadataQadamRebrand: Migration = {
    targetSchemaVersion: '29',
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
                        [AgentQadamProps.AGENT_TOOLS]: tools.map(rebrandToolMetadata),
                    },
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '30',
        }
    },
}

function rebrandToolMetadata(tool: AgentToolInput): AgentToolInput {
    if (tool.type !== AgentToolType.PIECE || !isNil(tool.qadamMetadata) || isNil(tool.pieceMetadata)) {
        return tool
    }
    const { pieceMetadata, ...rest } = tool
    return {
        ...rest,
        qadamMetadata: pieceMetadata,
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
