/**
 * #264. Which chat tools the model may not run on its own word.
 *
 * The list is explicit rather than derived from `annotations`, because the annotations are wrong in
 * the direction that matters. Audited against every tool in `app/mcp/tools/` on 2026-07-31:
 * `destructiveHint || openWorldHint` selects the five deletes, `ap_run_action`, `ap_test_flow` and
 * `ap_test_step` — and **misses `ap_lock_and_publish` and `ap_change_flow_status` entirely**, both
 * of which declare `destructiveHint: false` while publishing or enabling a flow that then runs
 * against real data. Deriving the gate from a hint that is `false` on a tool with real effects is a
 * gate that fails open and looks correct.
 *
 * `ap_test_step` is deliberately absent even though it is `openWorldHint: true` and really does
 * execute one configured step, connection and all: it is the model's normal build-and-check loop,
 * and gating it would put a confirmation prompt between the model and every step it configures,
 * which makes flow-building unusable. Recorded here because it used to appear in the (now removed)
 * `tool-classification.ts` list, so its absence would otherwise read as a regression.
 *
 * `ap_retry_run` re-executes a *published* flow against real data and is arguably in the same class
 * as `ap_test_flow`, yet it is invisible to the annotations and is not in the agreed set. Raised on
 * #264 for a decision rather than added silently — until that lands, its absence is a known gap,
 * not an oversight, and the cross-check test cannot catch it either.
 */
const GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
    // Destructive by their own annotation.
    'ap_delete_branch',
    'ap_delete_flow',
    'ap_delete_records',
    'ap_delete_step',
    'ap_delete_table',
    'ap_run_action',
    // Real effects, `destructiveHint: false`. See the audit above.
    'ap_test_flow',
    'ap_lock_and_publish',
    'ap_change_flow_status',
])

export const chatToolGating = {
    /**
     * Gating is per tool call, never per conversation: the AI SDK mints one `approvalId` per
     * `tool-approval-request`, so approving one call cannot carry over to the next.
     *
     * The three tools whose gate #264 describes as conditional on the flow sending data outward are
     * gated unconditionally here. No outbound signal exists anywhere in the codebase to condition
     * on, and the only safe way to compute one is a default-deny walk of the flow's steps under
     * which nearly every real flow is outbound anyway. Gating them always is therefore the same
     * outcome for the user and strictly safer in the meantime; relaxing it later is a change that
     * can be reviewed on its own merits, whereas shipping the relaxed version first cannot be undone
     * for anyone it has already let through.
     */
    requiresApproval(toolName: string): boolean {
        return GATED_TOOL_NAMES.has(toolName)
    },
    names(): ReadonlySet<string> {
        return GATED_TOOL_NAMES
    },
}
