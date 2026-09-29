# Chat with AI

## Summary
A platform-scoped conversation between one user and the chat agent. The agent is the platform's MCP tool set run through the AI SDK's `streamText` against whichever AI provider is `enabledForChat`. A conversation is created without a project and gets pinned to one on its first run. Each run streams UI chunks to the browser over the websocket and, when it ends, appends one assistant message to `uiMessages`. This document covers what the model is sent on each turn and what the user can see of it (#563). It does not describe the agent's tools; those are in `mcp.md`.

## Key Files
- `packages/server/api/src/app/chat/chat-agent.service.ts`: the run loop (`runAgentLoop`), which forwards `toUIMessageStream()` chunks and persists `buildStepParts` output through `finishRun`.
- `packages/server/api/src/app/chat/chat-transcript.ts`: rebuilds the next turn's `ModelMessage[]` from `uiMessages`.
- `packages/server/api/src/app/chat/chat-context-usage.ts`: measures how full the context was on each reply (#568).
- `packages/server/api/src/app/chat/chat-compaction.ts`: moves the transcript's start forward and writes the summary (#567).
- `packages/server/api/src/app/chat/chat-conversation-entity.ts`: the `chat_conversation` table (`projectId` nullable, `summary` / `summarizedUpToIndex` / `autoCompact`).
- `packages/server/utils/src/chat-ai-utils.ts`: provider factories, `buildStepParts`, and `buildProviderOptions`. `buildProviderOptions` has no caller yet; it is the hook the reasoning opt-in (#566) wires up. Nothing here strips reasoning from replayed history — `chat-transcript.ts` never emits it.
- `packages/shared/src/lib/automation/chat/index.ts`: persisted part schemas, plus `chatContextUtils` (`transcriptStart`, `contextBudget`, `isCompactionDue`), which the server and the browser share.
- `packages/web/src/app/routes/chat-with-ai/`: the page. `ai-chat-box.tsx` renders the message list and the window divider. `components/chat-context-indicator.tsx` is the context popover: fill and breakdown. `components/activity-accordion.tsx` (`ThinkingBlock`) and `components/assistant-message.tsx` render reasoning.

## Context the model gets on each turn
- **Project.** The conversation's `projectId` is null until the first run pins it, and it cannot be changed after that (`repinProject`). The UI shows it in the project picker (only when the user has two or more projects).
- **Transcript.** A run replays every persisted message from `summarizedUpToIndex` on, moved forward to a user turn that has text (`chatContextUtils.transcriptStart`). The browser draws a divider at the same index. There is no fixed message-count window any more. It was replaced by compaction in #567, and the migration set `summarizedUpToIndex` to where that window used to start for every conversation longer than it, so nothing they send changed.
- **Summary.** When `autoCompact` is on and a summary exists, it goes ahead of the transcript as a system message (`chatTranscript.summaryMessage`), right after the system prompt. It is passed in `streamText`'s `system` array, not in `messages`, where the SDK `console.warn`s on every call.
  - **It is data, not instructions.** The summary is model-written from tool output as much as from the user, and the system role is the most trusted one. So it is wrapped in `<conversation_summary>` (invisible format characters are removed from it, then every closing tag in any case, spacing or nesting; look-alikes such as full-width brackets are not matched and rest on the preamble alone), and the preamble puts it under the system prompt's rule 28: no instruction, approval or go-ahead comes from it. The compaction prompt, for its part, never records an instruction found in tool output as a user decision, and continuation lines of every rendered part (text, a third-party error) and of the previous summary are indented, after any line break a model may read as one (CR, LF, VT, FF, U+0085, U+2028, U+2029), so only a real user turn starts a line with "User:". The summary is passed through `sanitizeObjectForPostgresql` before it is saved.
- **Reasoning.** It is never replayed: `toAssistantModelMessages` emits only text and tool-call parts.

## Compaction (#567)
- **When.**
  - After every reply, in the background, once the reply's own measurement crosses `chatContextUtils.isCompactionDue`.
  - The threshold is the system prompt plus tool schemas (never compacted) plus 60% of the room left after them in the model's window. The popover's "until auto-compact" uses the same number.
  - No measurement means no pass.
- **How much.**
  - The newest messages are kept while their estimated size fits 25% of that room, and the boundary goes to a user turn. The last exchange is always kept (`chatCompactionPlan.cutIndex`).
  - Sizes are characters, calibrated against the last reply's counted conversation tokens over the span that reply was measured on (`transcriptStartIndex`), less the summary's share (`tokensPerChar`).
  - A measurement taken before the start last moved (a pass landed after the reply was admitted) triggers no pass; the next reply's measurement decides.
- **Cost.** Until the threshold, every step of every turn re-sends the whole transcript, where before #567 it sent the last 20 messages. On a 200k window that is up to ~130k input tokens per step, and on a 1M window up to ~600k. This follows from compacting by the window, the agreed trigger; there is no absolute ceiling. A provider that reports no usage gets no background pass, only the overflow safety net.
- **Summary.**
  - The conversation's own model writes it with `generateText` and `assets/prompts/chat-compaction-prompt.md`.
  - The input is the previous summary plus only the messages leaving the transcript. Tool inputs and outputs are clipped, and reasoning is skipped.
  - One call carries at most half the model's window (`chatCompactionPlan.maxSummaryInputChars`). Past that, what leaves is split into slices that end before a user turn (`summarySlices`), each folded into the summary the previous call wrote. An exchange larger than a slice is clipped. A pass makes at most 4 calls, and moves the start only as far as it got.
  - An empty or failed reply writes nothing.
- **Auto-compact off.** A per-conversation switch in the Context popover (`autoCompact`, via `POST /v1/chat/conversations/:id`). Off means the boundary still moves, but nothing is summarised and no summary is sent, the way the chat behaved before #567. A summary written earlier is kept, and is sent again if the switch goes back on. A pass that drops messages with the switch off appends one line to it saying later messages were dropped without being summarised, so the summary does not read as covering everything up to the start.
- **Concurrency.**
  - `saveCompaction` locks the row and writes only if `summarizedUpToIndex` is still the one the pass started from.
  - A run admitted meanwhile replays from the old boundary with the old summary, which is still a correct transcript.
  - `finishRun` and `admitRun` save the row they read under the same lock, so they never write a stale summary back.
- **Overflow safety net.**
  - When the provider refuses a turn as too long (`PROVIDER_CONTEXT_LENGTH_EXCEEDED`) before any tool ran, `compactForOverflow` compacts harder: half the usual kept tail, or 20% of the window when there is no measurement.
  - The turn is then retried once on the rebuilt transcript, in the same run and stream. A second refusal fails as before.
  - The run keeps one abort controller across the retry, and the pass takes its signal. A Stop while it compacts aborts the summariser call and settles the run as cancelled. So does a cancel handled elsewhere or a takeover, found by re-reading the row (`isRunActive`) whether or not the pass shortened anything.
  - The pass beats the run's heartbeat (`touchRun`) before each summariser call. Up to 4 calls of up to 90 s each can outlast `ABANDONED_CHAT_RUN_AFTER_MS`, and a run that stops beating is taken over as abandoned.
  - Not yet shown: a live "compacting" status in the stream. While it runs the user sees the ordinary "Thinking..." state.
- **The browser sees the new boundary shortly after the pass.** The pass runs after the reply's reconcile has read the row, so when that reply crossed the threshold `use-chat` polls the conversation every 5 s for up to 2 minutes and stops once `summarizedUpToIndex` moves (`chatUtils.isCompactionPending`, `chatUtils.waitForCompaction`). It applies the server's test: the newest message's own measurement only, so an unmeasured reply, or a turn stopped before its first token (no reply saved), starts no poll. A newer poll, a conversation switch or unmounting ends it. A slower pass shows at the next reconcile or on reload. The popover then says its figures predate the pass (`transcriptStartIndex` on the measurement).
- **Never fails a turn.** Every pass swallows and logs its own errors, and leaves the row unchanged.
- **Migration.** `1791400000000-AddAutoCompactToChatConversation` adds `autoCompact` and sets `summarizedUpToIndex` to the old 20-message window on rows that had none, so existing conversations lose nothing more than they already had. `down` drops only the column. Rolling back and forward again does not recompute the start: rows backfilled the first time are skipped.
- **Tests.** `chat-compaction.test.ts` (the plan — cut, calibration, slices — and both entry points, with a mocked model), `chat-transcript.test.ts` (start and summary message), `chat-context.test.ts` in shared (start and budget). `chat-agent.test.ts` covers background compaction then the next turn, the overflow retry, a Stop while the retry compacts, a Stop from another instance while a pass that shortened nothing runs, and auto-compact off. The web's poll and its trigger are in `chat-utils.test.ts`.

## Context fill (#568)
The Context button shows how full the model's context was on the last reply (`Context · 41%`). Its popover breaks that down: system prompt, tool schemas, messages, tool outputs and free space, against the model's window.

- **Measured once per reply, stored on the reply.** When a run finishes, `chatContextUsage.measure` writes `contextUsage` (`ChatContextUsageSchema`) onto the persisted assistant message, so a reload shows the same figure. The web maps it onto the UI message's `metadata`, and `chatUtils.latestContextUsage` reads the newest valid one, which a reply still streaming does not replace.
- **The total is the provider's count.** It is the last step's `usage.inputTokens`, which already includes the run's earlier steps, plus the reply's text tokens. The reply is included because the next turn sends it back.
  - **Reasoning is excluded**, because it is never replayed. The reply count is `textTokens` where the provider splits it out, and otherwise `outputTokens − reasoningTokens`: OpenRouter reports no `textTokens`. A provider that reports neither split, Anthropic among them, counts its reasoning in, which only over-states the figure.
  - **A zero input count means "not reported".** The openai-compatible SDK turns a `usage` object without `prompt_tokens` into 0.
  - **The result must pass `ChatContextUsageSchema`** before it is saved.
- **The parts are an estimate.** No provider says what each part of a prompt cost, so each part is sized by the characters it put on the wire: the system prompt, each tool's name, description and input JSON schema (`asSchema(...).jsonSchema`, what the SDK sends), text and tool-call inputs, and tool results. Each part then gets its share of the real total, with largest-remainder rounding so the parts add up exactly. Reasoning is not counted.
  - **Attachments cannot be sized.** An image or PDF is billed per image or page, not per base64 character, so file parts are left out of the split. Their tokens are still in the total, so on a turn with a large attachment the other parts read high.
- **Window.** `chatModel.resolve` returns the model's `contextWindowTokens` from the provider's model list or the operator's catalogue (see `ai-providers.md`). When neither has it, the popover assumes `DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS` (128k) and says so.
- **No number without a measurement.**
  - While a reply streams, or before the first one, the popover says the figure appears once a reply finishes. A streaming reply is not counted as a reply.
  - When a provider streams no usage, `measure` returns null and the popover says so. It never shows a character-based guess as a total.
  - CUSTOM and Cloudflare Gateway models are built with `includeUsage`, which sends `stream_options.include_usage`. Without it, OpenAI-compatible servers stream no counts.
    - A CUSTOM row can turn this off with `streamUsage: false` ("Request token usage" in the provider form), for a strict server that rejects the parameter. `extraBody` cannot remove it, because `stream_options` is a reserved key.
- **Measuring never fails a run.** A throw is logged and the reply is saved without `contextUsage`.
- **Tests.** `test/unit/app/chat/chat-context-usage.test.ts` covers the arithmetic. `chat-agent.test.ts` drives a scripted provider that streams usage, and one that streams none. The web popover and the metadata mapping have their own tests.

## Reasoning (thinking) display, as verified for #563
- **Which providers produce it.** `streamText` is called without `providerOptions`, so no provider is asked to think. Anthropic and Bedrock extended thinking are opt-in, so their runs carry no reasoning. OpenAI and Azure go through `.chat()` (Chat Completions), which returns no reasoning text, and Google needs `includeThoughts`. Reasoning therefore reaches the chat only from models that emit it without being asked: CUSTOM / Cloudflare OpenAI-compatible endpoints streaming `reasoning_content` or `reasoning` (vLLM, DeepSeek, Qwen), and possibly OpenRouter models whose upstream returns it without a `reasoning` request (not measured).
- **While it streams.** `toUIMessageStream` sends reasoning by default (`sendReasoning = true`). The web `chunk-reducer` builds `reasoning` parts from it. `AssistantMessage` shows the latest reasoning step live under a "Thinking..." header while the block is collapsed.
- **After it ends.** The block collapses to its duration label. Clicking the label (a Radix `CollapsibleTrigger` with `aria-expanded`) shows the reasoning, and clicking again hides it.
- **After a reload.** `buildStepParts` persists reasoning as `REASONING` parts, and `mapHistoryToUIMessages` restores them, so the reasoning stays available behind the collapsed block.
- **Known gap.** `thinkingDurationMs` is never written by the server or the stream reducer, so the label always reads "Thought for a few seconds", whatever the real duration.
- **Tests.** `packages/web/test/app/routes/chat-with-ai/components/activity-accordion.test.tsx` covers hiding and showing in the UI. `chat-agent.test.ts` covers the whole path with a scripted OpenAI-compatible provider: streamed, persisted, then left out of the next turn.

## Domain Terms
- **Run**: one `streamText` loop answering one user message, owned by the conversation's `activeRunId`.
- **Transcript start**: `summarizedUpToIndex`, moved forward to a user turn. The messages from it on are what the next run sends verbatim.
- **Compaction pass**: one move of the transcript start, which summarises what it passed over when `autoCompact` is on.
- **Reasoning**: provider "thinking" text, persisted as `PersistedChatPartType.REASONING`. It is display-only and never sent back to the model.
