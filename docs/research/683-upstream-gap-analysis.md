# #683 — Upstream gap analysis: what Activepieces shipped since our base (0.85.2 → 0.92.x), CE vs EE

**Status:** research note, no product code change. This moves the 2026-10-03 snapshot from the
tracker issue into the repository, re-verifies it against the current tree, and corrects the
items whose CE/EE label or presence had drifted. It is input for the backport epic #115, not a
work plan.

**Investigated:** 2026-11-24, against `main` @ `51bb340b` (2026-11-13). Upstream is pinned at
`e3e1cbebb6` (the snapshot's tip, 2026-10-01 22:47Z / 2026-10-02 01:47 +0300) and was also
re-checked at `c9d5d62a` (`main`, 2026-11-24).

## What has moved since the snapshot was written

The snapshot is a month and a half old and upstream has not stood still:

| | 2026-10-03 snapshot | 2026-11-24 |
| --- | --- | --- |
| Upstream `main` | `e3e1cbebb6`, `package.json` 0.92.0 | `c9d5d62a`, `package.json` 0.94.0 (latest tag 0.93.0) |
| Non-merge commits since `e010d67183` | 1255 | 2205 |
| `feat` commits since `e010d67183` | 468 | 928 |

So this note is a 0.85.2 → 0.92.x analysis. Anything read for a port must be re-baselined against
`main` first — the section-A list below is not a claim that nothing newer arrived.

The exact figures above were produced with the snapshot's own method (blobless clone, `git
rev-list --count --no-merges e010d67183..<tip>`), not copied from the issue.

## Correction: our upstream base is 2026-06-11 / 0.85.2, not "v0.83.0"

`ROADMAP.md`, `CHANGELOG.md` and `docs/about/license.mdx` said we forked Activepieces v0.83.0.
`f611ac8` is the date *we* imported, not the upstream commit imported. The real cut:

- Last upstream commit present: `e010d67183` — *feat(web): horizontal canvas layout toggle
  (#13661)*, 2026-06-11 18:42 +0300, root `package.json` **0.85.2**.
- Everything upstream added up to that point is in our tree. We carry #13661's canvas toggle
  (`packages/web/src/app/builder/flow-canvas/canvas-controls.tsx:116-314`).
- The next merges are absent, and the absence is checkable: #13681's
  `1773627989514-AddPgVectorExtension.ts` and #13688's `canvas-controls/` directory plus
  `flow-screenshot-utils.ts` do not exist here; our `canvas-controls.tsx` is still the
  pre-screenshot single file.

That is consistent with the 0.83 → 0.85.2 features already shipped here (variables manager,
formula editor, step error handlers, health dashboard, chat voice/TTS, horizontal canvas). The
three stale statements were corrected in this PR.

## Method

- Upstream clone: `git clone --filter=blob:none --no-checkout --branch main`; then
  `git fetch --tags`.
- Counts: `git rev-list --count --no-merges e010d67183..<tip>` and
  `git log --no-merges --format='%s' e010d67183..<tip> | grep -c '^feat'`.
- License: `git show <merge-sha> --stat` and flag every path under `packages/ee/`,
  `packages/server/api/src/app/ee/`, or any `*/ee/` component.
- Presence here: `grep`/`find` in `packages/{server,web,shared,qadams}` at the branch tip. "No"
  below means the grep found nothing; a port must re-confirm before starting.

## License vs edition: two different filters

1. **License (can we copy it?).** Upstream `LICENSE` puts only `packages/ee/` and
   `packages/server/api/src/app/ee/` under the Enterprise License; everything else is MIT.
   `*/ee/*` paths outside those two (for example `packages/core/shared/src/lib/ee/agent`) are
   MIT by the letter, but `.agents/rules/edition-safety.md` says "when in doubt, treat as EE",
   so this note treats them as EE too.
2. **Edition (what upstream gives free users).** Verified at `e3e1cbebb6`: `OPEN_SOURCE_PLAN`
   has `agentsEnabled: false`, `chatEnabled: false`, `workerGroupsEnabled: false`,
   `environmentsEnabled: false`, `globalConnectionsEnabled: false`, `auditLogEnabled: false`,
   `customRolesEnabled: false`, `eventStreamingEnabled: false`, `customAppearanceEnabled: false`.
   At `e010d67183` it still had `agentsEnabled: true`. Upstream's free tier shrank; ours did not —
   `getPlan` in `packages/server/api/src/app/platform/platform.service.ts:243-274` returns
   `agentsEnabled: true` and `chatEnabled: true`.

The per-PR license labels below are the correction that matters most: several items the snapshot
filed as "portable" also edit files under `app/ee/`, and those edits are EE.

## A. Upstream features in CE/MIT paths that we do not have

Legend for **License**: **MIT** = no EE path touched; **MIT + EE** = the core is MIT but the PR
also edits Enterprise-licensed files, which must be clean-roomed; **EE core** = the actual
implementation is under an EE path and may only be reimplemented from behaviour.

| Feature | Upstream PRs | License | Here? | Evidence / notes |
| --- | --- | --- | --- | --- |
| **AI Router**: an `AI_ROUTER` step, one question picks the branch | #15707 | MIT + EE (one 5-line EE file) | **No** | `FlowActionType` has `ROUTER` only (`packages/shared/src/lib/automation/flows/actions/action.ts:13-17`); no `ai-router` files. Upstream core lives in `core/execution`, engine, web. |
| **Tool search**: natural-language action/trigger discovery via embeddings, off by default | #13839, #14027, #14408 | MIT | **No** | No `app/tool-search`; the only "tool search" hit is unrelated agent-tools text (`packages/qadams/community/ai/src/lib/actions/agents/tools.ts`). Needs an OpenAI key upstream; self-hosted falls back to keywords. |
| **Deno code sandbox** for CODE steps | #14370, #16009 | MIT + EE (admin migration service) | **No** | No Deno files or dependency; our sandbox is `isolated-vm`-based. Upstream added `packages/server/sandbox`. |
| **MCP**: connect-an-AI-client page, grant list/revoke, Connections tab, Activity tab, OIDC with email-domain restriction, own hostname, project members on the platform MCP via `READ_MCP` | #15077, #15078, #15079, #15076, #15240, #15241, #15243, #15604, #15376, #15649 | Mostly MIT; #15077 and #15649 touch EE | **Partial** | Already here: a connect-URL panel naming Cursor/Windsurf/Claude Desktop (`packages/web/src/app/components/project-settings/mcp-server/mcp-credentials.tsx:26`), an OAuth revoke endpoint (`packages/server/api/src/app/mcp/oauth/token/mcp-oauth-revoke.controller.ts:10`), project MCP gated on `READ_MCP` (`mcp-server-controller.ts:54`; every project role has it in `access-control-list.ts:27,53,71`). Missing: grants UI, Connections/Activity tabs, OIDC domain restriction, MCP-specific hostname, and platform MCP for non-admins — our platform MCP is `platformAdminOnly` (`mcp-platform-controller.ts:9-52`). Note: #15242 is not a PR (404); the Activity sequence is #15240/#15241/#15243. |
| **Recheck connection health** (revalidate); show connected account/status on a connection | #14349, #14402 | MIT + EE (#14349 touches `ee/chat` and worker `ee/`) | **Partial** | Status and owner are already columns in the connections list (`packages/web/src/app/routes/connections/index.tsx:135,165,215`; `AppConnectionStatus` is ACTIVE/MISSING/ERROR). No revalidate route: the controller has list/owners/upsert/update/replace/delete/oauth only (`app-connection.controller.ts:33-151`). |
| **Tables**: Date & Time column; drag-and-drop reorder; Create/Delete Table actions; streamed CSV export | #14768, #14157, #14278, #14318 | MIT + EE (#14157 touches EE project-state services) | **No** | `FieldType` has no DATE_TIME (`packages/shared/src/lib/automation/tables/field.ts:27-34`). No reorder. Core `tables` actions are clear/CRUD/find/download only — no create/delete table (`packages/qadams/core/tables/src/lib/actions/`). Download builds the whole CSV in memory and writes a Buffer (`download-table.ts:48-56`). Date & Time is tracked in #678. |
| **Per-project execution-data retention** | #14231 | MIT + EE (one line in the EE project controller) | **No** | Only the global `EXECUTION_DATA_RETENTION_DAYS` system prop is read (`flow-run-service.ts:227`, `access-token-manager.ts:32`, `mcp/tools/flow-run-utils.ts:497`). The project model has no retention field (`packages/shared/src/lib/management/project/project.ts:53-68`). |
| **Failure alert e-mail to the flow owner** (`notifyFlowOwnerOnFailure`) | #14313 | MIT flag/migration/UI + **EE sending** (`ee/alerts`, `ee/email`) | **No** | The project model has no flag. We do have project-level alert receivers (`packages/server/api/src/app/alerts/alerts-service.ts:27,82`), not an owner-on-failure toggle. The sending code upstream is EE — reimplement, do not copy. |
| **Platform toggle to disable automatic personal-project creation** | #14724 | MIT + EE (deletes EE controller lines) | **No** | Personal projects are created at platform claim (`platform.service.ts:282-296`); no platform flag among `platform.model.ts:40-61` or `platform.entity.ts`. |
| **Waitpoints**: a deadline on any waitpoint; barrier = waitpoint + one signal row per awaited thing | #14697, #14776, #14778 | MIT | **Partial / different** | Our join-waitpoint has a `timeoutSeconds` failure-policy field and delay waitpoints carry `resumeDateTime` (`packages/shared/src/lib/automation/flow-run/waitpoint/index.ts:16-19,47`), but no generic deadline on any waitpoint. Our barrier is the join/slot model (`join-waitpoint-service.ts`, `waitpoint-slot-entity.ts`); compare semantics before porting. |
| **Subflows**: stream a CSV, fan out one subflow per batch | #14281 | MIT | **No** | `packages/qadams/core/subflows/src/lib/actions/` has `call-flow.ts`, `call-flow-for-each.ts`, `respond.ts` only. |
| **Builder**: flow screenshots; testing UX (drawer/split, one-click test, run timeline rail, latency timeline); reusable property widgets; rewritten core-step forms | #13688, #13868, #13889, #13991, #14501, #15188, #15318, #15281, #15679, #15684, #15532, #15287, #15256, #15405 | Mostly MIT; #14501 touches `ee/agent` | **Partial** | No screenshots (`flow-screenshot-utils` and `canvas-controls/` absent). The run view has an `AgentTimeline` for agent steps only (`run-details/flow-step-input-output.tsx:291-299`), not a run-level latency rail. Per-widget/per-form rewrites were not assessed one by one; that is UI work to scope separately. |
| **Formula**: 23 more functions (text/number/date/list/logic) | #13869 | MIT | **Different** | We have our own engine at `packages/shared/src/lib/formula/` (87 functions; moved to `expr-eval-fork` in #616). Upstream's 23 were not ported; overlaps our #44–#49. See section C — our editor is currently switched off. |
| **Theme colours**: customise every theme colour from branding | #13698 | MIT + EE (`ee/helper/appearance-helper.ts`) | **No** | The platform stores `primaryColor` only (`packages/shared/src/lib/management/platform/platform.model.ts:94`); the palette is derived from it in `packages/server/api/src/app/flags/theme.ts:3-67`. The branding page is locked behind `customAppearanceEnabled` (`packages/web/src/app/routes/platform/setup/branding/index.tsx:16`). |
| **AI providers**: xAI, DeepSeek, Z.ai, Qwen, MiniMax, Moonshot; native Vertex; Bedrock via STS/SSO; Responses API; models.dev catalogue; key-health status | #14987, #15139, #15745, #15138, #15001, #14903 | MIT + EE (#15139, #14903 touch `ee/agent`) | **Partial** | `AIProviderName` has openai, openrouter, anthropic, azure, google, cloudflare-gateway, custom, bedrock, mistral (`packages/shared/src/lib/management/ai-providers/index.ts:7-17`). Missing the six named providers; Vertex exists only as a community qadam (`packages/qadams/community/google-vertexai`); Bedrock takes static `accessKeyId`/`secretAccessKey` (`index.ts:51-54`), not STS/SSO; no models.dev catalogue. Credentials are validated on create/update (`ai-provider-service.ts:217`), but no persisted health status. Multiple provider rows per type and `providerId` selection already exist; model/project scopes (#14738, #14942, EE-heavy) do not. |
| **Infra/observability**: Prometheus queue export; BullMQ metrics over OTEL; evlog wide events; structured `job.failed`; `host` on every log line | #14108, #14227, #13648, #15541, #15665 | #14108 is **EE core** (admin controller only); #13648 touches EE modules | **Partial** | We log with pino plus optional OTel transport (`packages/server/api/src/app/helper/logger/index.ts`, `transports/otel-transport.ts`). No Prometheus queue export, no evlog, no structured `job.failed` (only BullMQ's `failedReason` in `job-retry.ts:53`), no per-line `host`. Our worker diverged (prewarm, job timing), so take ideas, not diffs. |
| **Webhooks: large file uploads without memory limits** | #14251 | MIT + EE modules | **No** | Multipart is parsed and each file is buffered into a Buffer before storage (`webhook-request-converter.ts:139-203`); no streaming. Also listed in #115. |
| **CLI**: `project replace` (cross-instance mirroring); benchmark CLI | #13113, #14105 | **EE core for project replace** (`ee/projects/project-replace`, 736-line service); CLI wrapper MIT; benchmark MIT | **No** | The CLI has qadams/actions/triggers/workers commands only (`packages/cli/src/index.ts`). A port of `project replace` must be clean-room: the upstream implementation is entirely under `app/ee/` (plus `shared/lib/ee/audit-events`). |
| **Small API additions**: `GET /v1/app-connections/:id`; optional `externalId` on `POST /flows`; single-user read | #14090, #15162, #13193 | MIT for #14090/#15162; #13193 touches the EE users controller | **Partial** | No `GET /v1/app-connections/:id` (`app-connection.controller.ts:33-151`). `POST /flows` does not read a caller-supplied `externalId` (`flow.controller.ts:42`); the service comment explains why the caller-supplied path is not opened (`flow.service.ts:225-238`). Single-user read **already exists**: `GET /v1/users/:id`, platform-admin only (`packages/server/api/src/app/user/platform/platform-user-controller.ts:41`), and it predates our base (#13193 merged 2026-05-13). |
| **Pieces**: 67 new community pieces (669 → 736), AI atomics and output schemas across existing ones | — | MIT | **Different** | We have 211 community + 27 core qadams, curated for the region. Upstream had 736 community pieces at `e3e1cbebb6`; this was not re-verified piece by piece. Curate for the region per #115. |

## B. Upstream features that are EE — clean-room only

Confirmed against `OPEN_SOURCE_PLAN` at `e3e1cbebb6` and the `*/ee/` paths in the tree. We
already have our own clean-room versions of some of these (chat, agent-as-step, MCP); nothing
here should ever be copied from upstream.

| Feature | Upstream location / gate | What we have |
| --- | --- | --- |
| **AI chat**: cross-session memory, web search with citations, image generation/editing, feedback, onboarding personalisation, one action over many items, generative UI, eval playground | `ee/agent`, `chatEnabled: false` | Our own chat: voice/TTS, compaction, context-usage view, approval gates (#264). No memory, web search, images or feedback. |
| **Saved agents** as a first-class entity: create/share/publish, starter agents, try-before-live, run history, move projects, a flow step runs a saved agent; agent tools = subflows/knowledge base/external MCP; audit entries | `ee/agent` (`agent-entity`), `agentsEnabled: false` | Agent as a flow step with tools (qadam, flow, MCP, knowledge base); no saved-agent entity. |
| **Flow approvals** (request/grant/reject/withdraw) | `ee/flows/flow-approval`, gated on `environmentsEnabled` | No. |
| Per-project workers / worker groups | mixed CE/EE, `workerGroupsEnabled: false` | Partial: `WORKER_GROUP_ID` in the worker. |
| Per-project active-flow limits | `ee/projects` | No. |
| Audit log for agent and flow actions; rebuilt roles dialog | EE | `ProjectRole` exists; audit is roadmap "Later" (#31–#34). |
| Embed SDK, embed subdomain, event-streaming handler generator, global connections as replace source | `packages/ee`, `ee/*` | Flags off. |
| Billing (Autumn, AI credits, trials), e-mailed sign-in codes behind CAPTCHA, disposable-address blocking, PostHog funnels | cloud-only | Not relevant. |

## C. Found along the way: our formula editor is switched off for every edition

Our hard-coded plan in `platform.service.ts:250` returns `dataManipulationEnabled: false` for
every platform. `packages/web/src/app/builder/qadam-properties/text-input-with-mentions/tiptap-editor.tsx:129`
reads that flag and drops the function slash-menu (`:99`) and the preview (`:456,517-524`). So
the formula functions we built (#44–#49) cannot be inserted from the builder UI.

That is edition gating, which `AGENTS.md` forbids. Upstream removed the column and enabled the
editor for every edition in #14042 (verified: it adds
`1803000000000-DropDataManipulationEnabledFromPlatformPlan.ts`). This needs its own fix issue;
it is not fixed in this research PR.

## D. Do not port (upstream reverted or replaced)

- Ad-hoc runs: #14006, reverted in #14097.
- First workspace-shell split: #14298, #14303, #14304, #14306, reverted in #14330; re-landed
  differently as the chat-first rail (#15005).
- Queue-dispatcher refactor (#13998, reverted in #14316); the "Every X Minutes fires twice" fix;
  "run pieces in a fresh child process" (reverted in #15209).

## E. Porting cost and the shortlist

- **No cherry-picks.** Upstream moved `packages/shared` → `packages/core/shared`, split out
  `packages/core/execution` and `packages/server/sandbox`, and our tree has the
  `Piece` → `Qadam` rename. Every port is by behaviour + diff.
- **Strongest candidates:** AI Router (#15707), MCP Activity/Connections/grants (#15240/#15241/
  #15243, #15078/#15079), connection revalidate (#14349), Date & Time column (#678), per-project
  retention (#14231), owner failure alerts (#14313 — clean-room the sending). All except the
  MCP EE touches and the alert sender are MIT; the alert sender is a small clean-room job.
- **Re-baseline first.** Upstream `main` is now 0.94.0 with 2205 commits since our base and a
  further 950 since this snapshot's tip. A port should start from current `main`, not from
  `e3e1cbebb6`.
- **Do not treat section B as a backlog by default.** It is EE upstream; any item needs a
  product decision and a clean-room design before code.

## Follow-ups

- [x] Correct the fork-point statement in `ROADMAP.md`, `CHANGELOG.md` and
  `docs/about/license.mdx` (this PR).
- [ ] Open the formula-flag fix from section C.
- [ ] Split section A into backport issues under #115, using the corrected License column
  (especially: `project replace` and Prometheus export are EE, not portable).
- [ ] Decide which section B items, if any, get a clean-room reimplementation.

## How to check this document's claims

```bash
# Upstream counts and boundary (blobless clone; no checkout needed)
git clone --filter=blob:none --no-checkout --branch main https://github.com/activepieces/activepieces.git ap
cd ap && git fetch --tags
git rev-list --count --no-merges e010d67183..e3e1cbebb6      # 1255
git log --no-merges --format='%s' e010d67183..e3e1cbebb6 | grep -c '^feat'   # 468
git show e010d67183:package.json | grep -m1 '"version"'      # 0.85.2
git show e3e1cbebb6:packages/core/shared/src/lib/ee/billing/index.ts | grep -A30 OPEN_SOURCE_PLAN

# Presence on our side (from the repo root)
grep -n "FlowActionType" packages/shared/src/lib/automation/flows/actions/action.ts
grep -n "dataManipulationEnabled" packages/server/api/src/app/platform/platform.service.ts \
  packages/web/src/app/builder/qadam-properties/text-input-with-mentions/tiptap-editor.tsx
ls packages/qadams/core/tables/src/lib/actions
grep -rn "app.get\|app.post\|app.delete" packages/server/api/src/app/app-connection/app-connection.controller.ts
```
