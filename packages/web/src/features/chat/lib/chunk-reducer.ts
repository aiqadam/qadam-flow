import { isObject } from '@aiqadam/shared';
import { DynamicToolUIPart, UIMessageChunk } from 'ai';

import { ChatUIMessage } from './chat-types';

function createStreamingState({
  messageId,
  initialParts,
}: {
  messageId?: string;
  initialParts?: ChatUIMessage['parts'];
} = {}): StreamingState {
  return {
    message: {
      id: messageId ?? `stream-${Date.now()}`,
      role: 'assistant',
      parts: initialParts ? [...initialParts] : [],
    },
    activeTextParts: {},
    activeReasoningParts: {},
    partialToolCalls: {},
    seenToolCallIds: new Set(),
    thinkingStartedAt: null,
    replyStarted: false,
  };
}

function findToolPartIndex({
  state,
  toolCallId,
}: {
  state: StreamingState;
  toolCallId: string;
}): number {
  return state.message.parts.findIndex(
    (p) =>
      p.type === 'dynamic-tool' &&
      'toolCallId' in p &&
      p.toolCallId === toolCallId,
  );
}

function updateToolPartFields({
  state,
  idx,
  fields,
}: {
  state: StreamingState;
  idx: number;
  fields: Partial<
    Pick<
      MutableToolPart,
      'state' | 'input' | 'output' | 'errorText' | 'approval'
    >
  >;
}): void {
  const part = state.message.parts[idx] as MutableToolPart;
  if (fields.state !== undefined) part.state = fields.state;
  if ('input' in fields) part.input = fields.input;
  if ('output' in fields) part.output = fields.output;
  if ('errorText' in fields) part.errorText = fields.errorText;
  if ('approval' in fields) part.approval = fields.approval;
}

// `receivedAt` is a `performance.now()` reading from the chunk's arrival. Without it the chunk is
// applied but not timed.
function applyChunk({
  state,
  chunk,
  receivedAt,
}: {
  state: StreamingState;
  chunk: UIMessageChunk;
  receivedAt?: number;
}): void {
  switch (chunk.type) {
    case 'start': {
      if (chunk.messageId) {
        state.message.id = chunk.messageId;
      }
      // The first `start` only: an overflow retry streams a second one, and the server's clock,
      // which this mirrors, keeps running across the refused attempt and the compaction pass.
      if (state.thinkingStartedAt === null && receivedAt !== undefined) {
        state.thinkingStartedAt = receivedAt;
      }
      break;
    }

    case 'text-start': {
      const partIndex = state.message.parts.length;
      state.message.parts.push({ type: 'text', text: '' });
      state.activeTextParts[chunk.id] = partIndex;
      break;
    }

    case 'text-delta': {
      const idx = state.activeTextParts[chunk.id];
      if (idx === undefined) break;
      const part = state.message.parts[idx];
      if (part?.type === 'text') {
        part.text += chunk.delta;
      }
      if (!state.replyStarted && chunk.delta.length > 0) {
        state.replyStarted = true;
        recordThinkingDuration({ state, endedAt: receivedAt });
      }
      break;
    }

    case 'text-end': {
      delete state.activeTextParts[chunk.id];
      break;
    }

    case 'reasoning-start': {
      const partIndex = state.message.parts.length;
      state.message.parts.push({ type: 'reasoning', text: '' });
      state.activeReasoningParts[chunk.id] = partIndex;
      break;
    }

    case 'reasoning-delta': {
      const idx = state.activeReasoningParts[chunk.id];
      if (idx === undefined) break;
      const part = state.message.parts[idx];
      if (part?.type === 'reasoning') {
        part.text += chunk.delta;
      }
      break;
    }

    case 'reasoning-end': {
      delete state.activeReasoningParts[chunk.id];
      break;
    }

    case 'tool-input-start': {
      if (state.seenToolCallIds.has(chunk.toolCallId)) break;
      state.seenToolCallIds.add(chunk.toolCallId);

      state.message.parts.push({
        type: 'dynamic-tool',
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        title: chunk.title ?? chunk.toolName,
        state: 'input-streaming',
        input: undefined,
      });
      state.partialToolCalls[chunk.toolCallId] = {
        toolName: chunk.toolName,
        inputText: '',
      };
      break;
    }

    case 'tool-input-delta': {
      const partial = state.partialToolCalls[chunk.toolCallId];
      if (!partial) break;
      partial.inputText += chunk.inputTextDelta;
      break;
    }

    case 'tool-input-available': {
      const idx = findToolPartIndex({ state, toolCallId: chunk.toolCallId });
      if (idx === -1) {
        if (state.seenToolCallIds.has(chunk.toolCallId)) break;
        state.seenToolCallIds.add(chunk.toolCallId);
        state.message.parts.push({
          type: 'dynamic-tool',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          title: chunk.title ?? chunk.toolName,
          state: 'input-available',
          input: chunk.input,
        });
      } else {
        updateToolPartFields({
          state,
          idx,
          fields: { state: 'input-available', input: chunk.input },
        });
      }
      delete state.partialToolCalls[chunk.toolCallId];
      break;
    }

    case 'tool-input-error': {
      const idx = findToolPartIndex({ state, toolCallId: chunk.toolCallId });
      if (idx === -1) {
        state.message.parts.push({
          type: 'dynamic-tool',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          title: chunk.title ?? chunk.toolName,
          state: 'output-error',
          input: chunk.input,
          errorText: chunk.errorText,
        });
        state.seenToolCallIds.add(chunk.toolCallId);
      } else {
        updateToolPartFields({
          state,
          idx,
          fields: {
            state: 'output-error',
            input: chunk.input,
            errorText: chunk.errorText,
          },
        });
      }
      delete state.partialToolCalls[chunk.toolCallId];
      break;
    }

    case 'tool-output-available': {
      const idx = findToolPartIndex({ state, toolCallId: chunk.toolCallId });
      if (idx === -1) break;
      updateToolPartFields({
        state,
        idx,
        fields: { state: 'output-available', output: chunk.output },
      });
      break;
    }

    case 'tool-output-error': {
      const idx = findToolPartIndex({ state, toolCallId: chunk.toolCallId });
      if (idx === -1) break;
      updateToolPartFields({
        state,
        idx,
        fields: { state: 'output-error', errorText: chunk.errorText },
      });
      break;
    }

    case 'tool-output-denied': {
      const idx = findToolPartIndex({ state, toolCallId: chunk.toolCallId });
      if (idx === -1) break;
      updateToolPartFields({ state, idx, fields: { state: 'output-denied' } });
      break;
    }

    case 'start-step': {
      state.message.parts.push({ type: 'step-start' });
      break;
    }

    case 'finish-step': {
      state.activeTextParts = {};
      state.activeReasoningParts = {};
      break;
    }

    case 'source-url': {
      state.message.parts.push({
        type: 'source-url',
        sourceId: chunk.sourceId,
        url: chunk.url,
        title: chunk.title,
      });
      break;
    }

    case 'source-document': {
      state.message.parts.push({
        type: 'source-document',
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
        filename: chunk.filename,
      });
      break;
    }

    case 'file': {
      state.message.parts.push({
        type: 'file',
        mediaType: chunk.mediaType,
        url: chunk.url,
      });
      break;
    }

    // The chunk carries only `{ approvalId, toolCallId }`, so it has to be folded onto the tool part
    // the `tool-input-available` chunk already created — that is where the tool name and the
    // arguments the card has to show live. No-oping this was why a gate raised in the current run
    // never produced a card: the part stayed `input-available`, indistinguishable from a call that is
    // simply still running, and nothing else in the stream ever says an approval is waiting.
    case 'tool-approval-request': {
      const idx = findToolPartIndex({ state, toolCallId: chunk.toolCallId });
      if (idx === -1) break;
      updateToolPartFields({
        state,
        idx,
        fields: {
          state: 'approval-requested',
          approval: { id: chunk.approvalId },
        },
      });
      break;
    }

    // A run that never wrote text thought until its stream ended. Overwritten by a later `finish`
    // rather than kept, because a refused attempt's stream ends before the retry's reply begins.
    case 'finish': {
      if (!state.replyStarted) {
        recordThinkingDuration({ state, endedAt: receivedAt });
      }
      break;
    }

    case 'error':
    case 'abort':
    case 'message-metadata':
      break;

    default:
      break;
  }
}

// Mirrors `chatThinkingDuration.measure` on the server, so the live label reads what a reload will.
// Unmeasured when the stream was joined after its `start` — a tab reattaching mid-run cannot know
// when the run began, and the reload's persisted figure fills it in.
function recordThinkingDuration({
  state,
  endedAt,
}: {
  state: StreamingState;
  endedAt: number | undefined;
}): void {
  if (state.thinkingStartedAt === null || endedAt === undefined) return;
  state.message.metadata = {
    ...(isObject(state.message.metadata) ? state.message.metadata : {}),
    thinkingDurationMs: Math.max(
      0,
      Math.round(endedAt - state.thinkingStartedAt),
    ),
  };
}

function applyChunks({
  state,
  chunks,
  receivedAt,
}: {
  state: StreamingState;
  chunks: UIMessageChunk[];
  receivedAt?: number;
}): void {
  for (const chunk of chunks) {
    applyChunk({ state, chunk, receivedAt });
  }
}

function snapshotMessage({ state }: { state: StreamingState }): ChatUIMessage {
  return {
    ...state.message,
    parts: state.message.parts.map((part) => ({ ...part })),
  };
}

export const chunkReducer = {
  createStreamingState,
  applyChunk,
  applyChunks,
  snapshotMessage,
};

type MutableToolPart = Pick<
  DynamicToolUIPart,
  'type' | 'toolCallId' | 'toolName' | 'title'
> & {
  state: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string };
};

type StreamingState = {
  message: ChatUIMessage;
  activeTextParts: Record<string, number>;
  activeReasoningParts: Record<string, number>;
  partialToolCalls: Record<string, { toolName: string; inputText: string }>;
  seenToolCallIds: Set<string>;
  thinkingStartedAt: number | null;
  replyStarted: boolean;
};

export type { StreamingState };
