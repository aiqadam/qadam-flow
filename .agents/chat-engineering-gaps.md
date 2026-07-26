# Chat Engineering Gaps — Priority Order

## Priority 1: Batch Execution for One-Time Tasks
**Status:** Specified and plumbed in this repo; the `ap_execute_action` tool implementation is not in this repo (see below)
**Impact:** Critical for any multi-item task
**Effort:** Medium

Batch execution belongs to the **chat** tool `ap_execute_action`, which is a different tool from the
MCP tool `ap_run_action` (`packages/server/api/src/app/mcp/tools/ap-run-action.ts`). The chat system
prompt tells the model to never mix them up: "use `ap_discover_action_auth` to check auth, then
`ap_execute_action` to execute. Never use `ap_run_action`"
(`packages/server/api/src/assets/prompts/chat-system-prompt.md:105`). Do not cite `ap-run-action.ts`
as evidence about batching — it is unrelated to this feature.

**What is present in this repo:**
- **Behaviour spec** — the system prompt documents the batch contract: an `items` array of complete
  input objects ("max 100"), a `description` label for the progress card, one shared
  `pieceName`/`actionName`, and a live progress card
  (`packages/server/api/src/assets/prompts/chat-system-prompt.md:208-213`). The cap is an
  instruction to the model; no code in this repo enforces it.
- **Progress passthrough** — `buildStepParts` emits a `BATCH_PROGRESS` part whenever an
  `ap_execute_action` result carries a `batchProgress` key
  (`packages/server/utils/src/chat-ai-utils.ts:198-203`).
- **Shared types** — `BatchProgressData` / `BatchItemResult`
  (`packages/shared/src/lib/automation/chat/index.ts:219-234`).
- **UI** — `BatchProgressCard` plus `chatPartUtils.extractBatchProgressFromOutput`
  (`packages/web/src/app/routes/chat-with-ai/components/batch-progress-card.tsx`,
  `packages/web/src/features/chat/lib/chat-types.ts:167-175`).

**What could not be located in this repo — do not assume either way:**
- No tool registration or handler for `ap_execute_action`. `chatAiUtils`
  (`packages/server/utils/src/chat-ai-utils.ts:237-243`) only builds the model, reshapes history,
  and transforms output parts; it registers no tools, has no caller inside `packages/`, and
  `streamText` appears in `packages/server` only inside a comment. There is no `chat` module under
  `packages/server/api/src/app`.
- Consequently the actual `items[]` handling, per-item loop, and cap enforcement are **not visible
  here**. Where that loop runs (another repo, a deploy-time host, or not yet wired) was not
  determined — do not record it as absent, broken, or externally hosted without new evidence.
- The declared contract `ChatToolOutputs['ap_execute_action']`
  (`packages/shared/src/lib/automation/chat/index.ts:182-186`) has no `batchProgress` member and no
  `items` input, yet `chat-ai-utils.ts:198` forwards `batchProgress` via an `in` check — the
  passthrough carries a field the type contract does not declare. Worth reconciling.

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
