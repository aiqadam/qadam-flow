/**
 * #264. Which chat tools the model may not run on its own word.
 *
 * **Default-deny.** A tool is gated unless it is named in `UNGATED_TOOL_NAMES` below. This is the
 * second design: the first was an explicit list of the nine tools agreed on the ticket, and one
 * review pass found four more ungated tools with real effects — `ap_test_step`, `ap_manage_fields`,
 * `ap_retry_run`, `ap_update_record`. Enumerating the dangerous ones loses that race: such a list is
 * only as good as the last person who remembered to extend it, and a gate that fails open is worse
 * than no gate because it reads as protection. Inverted, a tool added next month is gated by
 * arriving, and someone has to argue in review that it is safe.
 *
 * The annotations cannot be the source of truth, which is why this list is hand-written and tested
 * against the registry. Audited across all 42 registered tools on 2026-07-31:
 * `destructiveHint || openWorldHint` selects the five deletes, `ap_run_action`, `ap_test_flow`,
 * `ap_test_step` and `ap_list_ai_models` — so it **under**-selects (missing `ap_lock_and_publish`
 * and `ap_change_flow_status`, which publish or enable a flow that then runs against real data, and
 * `ap_retry_run`, which re-executes a *published* flow; all three declare `destructiveHint: false`)
 * and **over**-selects (`ap_list_ai_models` is `readOnlyHint: true` and harmless) at the same time.
 *
 * Why each ungated group is safe:
 * - **Read-only.** No writes at all.
 * - **Draft-only flow edits.** They change a draft `flowVersion`; what a published flow does cannot
 *   change until `ap_lock_and_publish`, which is gated.
 * - **Canvas annotations.** `ap_manage_notes` (including its `DELETE` path) only mutates
 *   `flowVersion.notes` (`notes-operations.ts`), a field no code path in the engine or worker ever
 *   reads (verified 2026-08-07) — so unlike the draft-only group above, a note's effect never
 *   surfaces even after `ap_lock_and_publish`. This tool was previously and incorrectly grouped under
 *   "Additive table writes" below; its comment claimed nothing is destroyed, which was false the
 *   moment `operation: 'DELETE'` (`ap-manage-notes.ts:19,109-121`) shipped. The group membership was
 *   still accidentally safe — deleting a note destroys a visual annotation, never live data — but the
 *   stated reason was wrong, which is why it has its own category now instead of borrowing this one's.
 * - **Additive table writes.** They add an empty table or new rows; nothing existing is overwritten
 *   or destroyed. Note the asymmetry with `ap_update_record` and `ap_manage_fields`, gated precisely
 *   because they are not additive. This group must never contain a tool with a DELETE/UPDATE-shaped
 *   `operation` — `chat-tool-gating.test.ts` enforces that by inspecting each member's input schema,
 *   not just its name.
 *
 * Gated beyond the ticket's agreed nine, each for a reason review established rather than for
 * symmetry:
 * - `ap_test_step` — `executeFlowTest` runs **every step up to and including** the named one
 *   (`ap-test-step.ts:24-25`, `flow-run-utils.ts:19-88`), connections included. Without it an
 *   ungated `ap_add_step` followed by `ap_test_step` reproduces the gated `ap_run_action`, which is
 *   the injection path #264 exists to close. It costs the model a confirmation inside its normal
 *   build-and-check loop; that cost is what makes the gate mean anything.
 * - `ap_manage_fields` — `operation: 'DELETE'` drops a field and `cell.entity.ts:43` cascades to
 *   every cell of that column in every record. `ap_delete_records` is gated; losing a whole column
 *   must not be cheaper than losing rows.
 * - `ap_update_record` — overwrites cells with no history to restore from.
 * - `ap_retry_run` — re-executes a published flow against real data. Raised as an open question on
 *   #264; gating is the safe direction and reversing it is one line.
 */
export const chatToolGating = {
    /**
     * Gating is per tool call, never per conversation: the AI SDK mints one `approvalId` per
     * `tool-approval-request`, so approving one call cannot carry over to the next.
     *
     * Read synchronously — the SDK awaits this inside the transform that pumps provider chunks
     * (`ai/dist/index.mjs:6263`), so any I/O here stalls the stream and eats into the first-token
     * timeout tuned in #266.
     *
     * The three tools #264 describes as conditional on the flow sending data outward are gated
     * unconditionally. No outbound signal exists anywhere in the codebase, and the only safe way to
     * compute one is a default-deny walk of the flow's steps under which nearly every real flow is
     * outbound anyway — the same outcome for the user, arrived at expensively. Relaxing later is
     * reviewable on its own merits; shipping relaxed first cannot be undone for whoever it already
     * let through.
     */
    requiresApproval(toolName: string): boolean {
        return !UNGATED_TOOL_NAMES.has(toolName)
    },
    ungatedNames(): ReadonlySet<string> {
        return UNGATED_TOOL_NAMES
    },
    additiveOnlyNames(): ReadonlySet<string> {
        return ADDITIVE_ONLY_TOOL_NAMES
    },
}

const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    'ap_find_records',
    'ap_flow_structure',
    'ap_get_piece_props',
    'ap_get_run',
    'ap_list_ai_models',
    'ap_list_connections',
    'ap_list_flows',
    'ap_list_runs',
    'ap_list_tables',
    'ap_read_step_code',
    'ap_research_pieces',
    'ap_resolve_property_chain',
    'ap_resolve_property_options',
    'ap_setup_guide',
    'ap_validate_flow',
    'ap_validate_step_config',
])

// Cannot change what a published flow does without `ap_lock_and_publish`.
const DRAFT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    'ap_add_branch',
    'ap_add_step',
    'ap_build_flow',
    'ap_create_flow',
    'ap_duplicate_flow',
    'ap_rename_flow',
    'ap_update_branch',
    'ap_update_step',
    'ap_update_trigger',
])

// Notes never reach the engine/worker, so even DELETE only destroys a visual annotation, never
// live data — see the "Canvas annotations" rationale above.
const CANVAS_ANNOTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
    'ap_manage_notes',
])

// Nothing existing is overwritten or destroyed. Must never grow a DELETE/UPDATE-shaped `operation` —
// see the drift test's schema-level check.
const ADDITIVE_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    'ap_create_table',
    'ap_insert_records',
])

const UNGATED_TOOL_NAMES: ReadonlySet<string> = new Set([
    ...READ_ONLY_TOOL_NAMES,
    ...DRAFT_ONLY_TOOL_NAMES,
    ...CANVAS_ANNOTATION_TOOL_NAMES,
    ...ADDITIVE_ONLY_TOOL_NAMES,
])
