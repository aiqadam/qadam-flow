import {
  ChatContextUsage,
  ChatConversation,
  ChatConversationStatus,
  PersistedChatPartType,
  PersistedChatRole,
} from '@aiqadam/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatUIMessage } from '@/features/chat/lib/chat-types';
import { chatUtils } from '@/features/chat/lib/chat-utils';

describe('chatUtils.isCompactionPending', () => {
  // 10k window, 2k fixed: the pass is due above 2k + 60% of 8k = 6.8k.
  const due = (
    overrides: Partial<ChatContextUsage> = {},
  ): ChatContextUsage => ({
    modelId: 'm',
    usedTokens: 7_000,
    contextWindowTokens: 10_000,
    breakdown: {
      systemPrompt: 1_000,
      tools: 1_000,
      toolCount: 3,
      messages: 5_000,
      toolOutputs: 0,
    },
    ...overrides,
  });
  const measured = ({
    id,
    usage,
  }: {
    id: string;
    usage: ChatContextUsage;
  }): ChatUIMessage => ({
    ...message({ id, role: 'assistant' }),
    metadata: { contextUsage: usage },
  });

  it('is pending after a reply whose own measurement crossed the threshold', () => {
    const messages = [
      message({ id: 'u', role: 'user' }),
      measured({ id: 'a', usage: due() }),
    ];

    expect(
      chatUtils.isCompactionPending({
        messages,
        summarizedUpToIndex: null,
        autoCompact: true,
      }),
    ).toBe(true);
    expect(
      chatUtils.isCompactionPending({
        messages,
        summarizedUpToIndex: null,
        autoCompact: false,
      }),
    ).toBe(false);
  });

  it('reads only the newest reply, as the server does, not an older measurement', () => {
    const messages = [
      message({ id: 'u0', role: 'user' }),
      measured({ id: 'a0', usage: due() }),
      message({ id: 'u1', role: 'user' }),
      // Cancelled, or from a provider that reports no usage: no pass follows it.
      message({ id: 'a1', role: 'assistant' }),
    ];

    expect(
      chatUtils.isCompactionPending({
        messages,
        summarizedUpToIndex: null,
        autoCompact: true,
      }),
    ).toBe(false);
  });

  it('is not pending when the turn was stopped before its first token and saved no reply', () => {
    const messages = [
      message({ id: 'u0', role: 'user' }),
      measured({ id: 'a0', usage: due() }),
      message({ id: 'u1', role: 'user' }),
    ];

    expect(
      chatUtils.isCompactionPending({
        messages,
        summarizedUpToIndex: null,
        autoCompact: true,
      }),
    ).toBe(false);
  });

  it('is not pending under the threshold, or on a measurement taken before the start last moved', () => {
    const under = [
      message({ id: 'u', role: 'user' }),
      measured({ id: 'a', usage: due({ usedTokens: 6_800 }) }),
    ];
    const stale = [
      message({ id: 'u0', role: 'user' }),
      message({ id: 'a0', role: 'assistant' }),
      message({ id: 'u1', role: 'user' }),
      measured({ id: 'a1', usage: due({ transcriptStartIndex: 0 }) }),
    ];

    expect(
      chatUtils.isCompactionPending({
        messages: under,
        summarizedUpToIndex: null,
        autoCompact: true,
      }),
    ).toBe(false);
    expect(
      chatUtils.isCompactionPending({
        messages: stale,
        summarizedUpToIndex: 2,
        autoCompact: true,
      }),
    ).toBe(false);
  });
});

describe('chatUtils.waitForCompaction', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const conversation = (
    summarizedUpToIndex: number | null,
  ): ChatConversation => ({
    id: 'c',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    platformId: 'p',
    projectId: null,
    userId: 'u',
    title: null,
    modelName: null,
    status: ChatConversationStatus.IDLE,
    messages: [],
    uiMessages: null,
    summary: null,
    summarizedUpToIndex,
    autoCompact: true,
  });

  it('polls until the start moves and returns the row that shows it', async () => {
    vi.useFakeTimers();
    const reads = [conversation(null), conversation(null), conversation(12)];
    const read = vi.fn(async () => reads.shift() ?? conversation(12));

    const waiting = chatUtils.waitForCompaction({
      fromIndex: null,
      read,
      isCurrent: () => true,
      deadlineMs: 60_000,
      intervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(15_000);

    expect((await waiting)?.summarizedUpToIndex).toBe(12);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up at the deadline, and stops as soon as the wait is no longer wanted', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => conversation(null));

    const timedOut = chatUtils.waitForCompaction({
      fromIndex: null,
      read,
      isCurrent: () => true,
      deadlineMs: 20_000,
      intervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await timedOut).toBeNull();
    expect(read).toHaveBeenCalledTimes(4);

    read.mockClear();
    const superseded = chatUtils.waitForCompaction({
      fromIndex: null,
      read,
      isCurrent: () => false,
      deadlineMs: 20_000,
      intervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await superseded).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('chatUtils.latestContextUsage', () => {
  const usage: ChatContextUsage = {
    modelId: 'm',
    usedTokens: 1_000,
    contextWindowTokens: null,
    breakdown: {
      systemPrompt: 400,
      tools: 400,
      toolCount: 3,
      messages: 200,
      toolOutputs: 0,
    },
  };

  it('reads the measurement a persisted reply carries after the reload mapping', () => {
    const messages = chatUtils.mapHistoryToUIMessages([
      {
        role: PersistedChatRole.USER,
        parts: [{ type: PersistedChatPartType.TEXT, text: 'hi' }],
      },
      {
        role: PersistedChatRole.ASSISTANT,
        parts: [{ type: PersistedChatPartType.TEXT, text: 'hello' }],
        contextUsage: usage,
      },
    ]);

    expect(chatUtils.latestContextUsage({ messages })).toEqual(usage);
  });

  it('keeps the last real figure while a newer reply has none yet', () => {
    const measuredReply: ChatUIMessage = {
      ...message({ id: 'hist-1', role: 'assistant' }),
      metadata: { contextUsage: usage },
    };
    const messages = [
      message({ id: 'hist-0', role: 'user' }),
      measuredReply,
      message({ id: 'optimistic', role: 'user' }),
      message({ id: 'streaming', role: 'assistant' }),
    ];

    expect(chatUtils.latestContextUsage({ messages })).toEqual(usage);
  });

  it('ignores metadata that is not a measurement', () => {
    const messages: ChatUIMessage[] = [
      {
        ...message({ id: 'a', role: 'assistant' }),
        metadata: { contextUsage: { usedTokens: 'lots' } },
      },
    ];

    expect(chatUtils.latestContextUsage({ messages })).toBeNull();
  });
});

function message({
  id,
  role,
}: {
  id: string;
  role: 'user' | 'assistant';
}): ChatUIMessage {
  return { id, role, parts: [{ type: 'text', text: id }] };
}
