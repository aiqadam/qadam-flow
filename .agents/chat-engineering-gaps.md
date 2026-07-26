# Chat Engineering Gaps — Priority Order

## Priority 1: Batch Execution for One-Time Tasks
**Status:** Partially landed — UI only
**Impact:** Critical for any multi-item task
**Effort:** Medium

**Landed:** the chat UI can render batch progress — `BatchProgressData` (`packages/shared/src/lib/automation/chat/index.ts`) plus `BatchProgressCard` / `chatPartUtils.extractBatchProgressFromOutput` in `packages/web/src/app/routes/chat-with-ai/`.

**Still missing:** there is no batch-capable tool on the server. The ad-hoc execution tool is `ap_run_action` (`packages/server/api/src/app/mcp/tools/ap-run-action.ts`) and it runs exactly one action — no `items[]` input, no per-item cap, no worker-side batch loop, and nothing emits `batchProgress`.

---

## Priority 2: Value-Before-Auth Flow
**Status:** Not started
**Impact:** High — users hit auth wall before getting any value, kills conversion
**Effort:** Low (prompt-only change)

**Problem:** The agent calls `ap_discover_action_auth` → immediately requests connection. Users are asked to authenticate before understanding what the agent will do for them. Zero value delivered before the ask.

**Fix:** Add system prompt rule: "Before requesting connections, explain what you will do and show the execution plan. Only request auth after the user confirms the approach." This is a prompt-only change with outsized impact on first-time experience.

---

## Priority 3: Connection-Based Suggestions
**Status:** Not started
**Impact:** Medium — existing users get no personalized experience
**Effort:** Medium

**Problem:** Chat does not suggest actions based on existing connections. A user with Slack, GitHub, and Google Sheets connected sees the same generic empty state as a brand new user.

**Fix:** On conversation start, query user's connections and show personalized suggestions via `ap_show_quick_replies` (e.g. "Send a Slack message", "Check GitHub PRs", "Add a row to your spreadsheet"). Inject connection context into the first-message prompt.

---

## Priority 4: Analytics Events
**Status:** Not started
**Impact:** Medium — flying blind on whether tasks succeed, cannot measure PMF
**Effort:** Low-Medium

**Problem:** Current telemetry only syncs tool call counts to console. No outcome-level tracking. Cannot answer: "Do users complete tasks?", "Do one-time tasks convert to flows?", "Which task types succeed?"

**Fix:** Add 3 events:
- `CHAT_TASK_COMPLETED` — fires when a one-time action or batch succeeds
- `CHAT_FLOW_CREATED` — fires when `ap_build_flow` completes successfully from chat
- `CHAT_CONVERSION` — fires when user converts a one-time task to a flow (Gap 2's "Automate This?" path)

---

## Completed

### ~~Gap 2: "Automate This?" Suggestion~~
**Status:** Done
System prompt suggests converting successful one-time tasks to flows via `ap_show_quick_replies`.
