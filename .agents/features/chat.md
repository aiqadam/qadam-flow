# Chat with AI

## Summary
A platform-scoped conversation between one user and the chat agent. The agent is the platform's MCP tool set run through the AI SDK's `streamText` against whichever AI provider is `enabledForChat`. A conversation is created without a project and gets pinned to one on its first run. Each run streams UI chunks to the browser over the websocket and, when it ends, appends one assistant message to `uiMessages`. This document covers what the model is sent on each turn and what the user can see of it (#563). It does not describe the agent's tools; those are in `mcp.md`.

## Key Files
- `packages/server/api/src/app/chat/chat-agent.service.ts`: the run loop (`runAgentLoop`), which forwards `toUIMessageStream()` chunks and persists `buildStepParts` output through `finishRun`.
- `packages/server/api/src/app/chat/chat-transcript.ts`: rebuilds the next turn's `ModelMessage[]` from `uiMessages`.
- `packages/server/api/src/app/chat/chat-conversation-entity.ts`: the `chat_conversation` table (`projectId` nullable, `summary` / `summarizedUpToIndex`).
- `packages/server/utils/src/chat-ai-utils.ts`: provider factories, `buildStepParts`, and `buildProviderOptions` / `stripThinkingBlocks`. Neither of the last two has a caller.
- `packages/shared/src/lib/automation/chat/index.ts`: persisted part schemas, plus `CHAT_MAX_REPLAYED_MESSAGES` and `chatContextUtils.replayWindowStart`, which the server and the browser share.
- `packages/web/src/app/routes/chat-with-ai/`: the page. `ai-chat-box.tsx` renders the message list and the window divider. `components/chat-context-indicator.tsx` is the context popover. `components/activity-accordion.tsx` (`ThinkingBlock`) and `components/assistant-message.tsx` render reasoning.

## Context the model gets on each turn
- **Project.** The conversation's `projectId` is null until the first run pins it, and it cannot be changed after that (`repinProject`). The UI shows it in the project picker (only when the user has two or more projects) and in the context popover.
- **History window.** The model is sent only the newest `CHAT_MAX_REPLAYED_MESSAGES` (20) persisted messages. The window is moved forward so it opens on a user turn that has text. The browser runs the same `replayWindowStart` over its own message list, which matches the persisted list one to one between runs. It uses the result to draw a divider above the first message still sent, and to fill the "Messages" row of the context popover.
- **Summary / compaction.** Nothing is written to `summary` / `summarizedUpToIndex`, and `assets/prompts/chat-compaction-prompt.md` is loaded by no code path. Messages that fall out of the window are dropped, not summarized. The UI therefore shows no summary state. Add a row to the popover when a compaction pass actually exists.
- **Context-window fill.** Not shown. No provider row records a model's context size, and token usage is not forwarded to the browser. The only signal today is the `PROVIDER_CONTEXT_LENGTH_EXCEEDED` error classification.
- **Reasoning.** It is never replayed: `toAssistantModelMessages` emits only text and tool-call parts. The popover states this.

## Reasoning (thinking) display, as verified for #563
- **Which providers produce it.** `streamText` is called without `providerOptions`, so no provider is asked to think. Anthropic and Bedrock extended thinking are opt-in, so their runs carry no reasoning. OpenAI and Azure go through `.chat()` (Chat Completions), which returns no reasoning text, and Google needs `includeThoughts`. Reasoning therefore reaches the chat only from models that emit it without being asked: CUSTOM / Cloudflare OpenAI-compatible endpoints streaming `reasoning_content` or `reasoning` (vLLM, DeepSeek, Qwen), and possibly OpenRouter models whose upstream returns it without a `reasoning` request (not measured).
- **While it streams.** `toUIMessageStream` sends reasoning by default (`sendReasoning = true`). The web `chunk-reducer` builds `reasoning` parts from it. `AssistantMessage` shows the latest reasoning step live under a "Thinking..." header while the block is collapsed.
- **After it ends.** The block collapses to its duration label. Clicking the label (a Radix `CollapsibleTrigger` with `aria-expanded`) shows the reasoning, and clicking again hides it.
- **After a reload.** `buildStepParts` persists reasoning as `REASONING` parts, and `mapHistoryToUIMessages` restores them, so the reasoning stays available behind the collapsed block.
- **Known gap.** `thinkingDurationMs` is never written by the server or the stream reducer, so the label always reads "Thought for a few seconds", whatever the real duration.
- **Tests.** `packages/web/test/app/routes/chat-with-ai/components/activity-accordion.test.tsx` covers hiding and showing in the UI. `chat-agent.test.ts` covers the whole path with a scripted OpenAI-compatible provider: streamed, persisted, then left out of the next turn.

## Domain Terms
- **Run**: one `streamText` loop answering one user message, owned by the conversation's `activeRunId`.
- **Replayed window**: the persisted messages that the next run sends to the model.
- **Reasoning**: provider "thinking" text, persisted as `PersistedChatPartType.REASONING`. It is display-only and never sent back to the model.
