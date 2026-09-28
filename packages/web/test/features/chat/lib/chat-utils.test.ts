import {
  ChatContextUsage,
  PersistedChatPartType,
  PersistedChatRole,
} from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';

import { ChatUIMessage } from '@/features/chat/lib/chat-types';
import { chatUtils } from '@/features/chat/lib/chat-utils';

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
      { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'hi' }] },
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
      { ...message({ id: 'a', role: 'assistant' }), metadata: { contextUsage: { usedTokens: 'lots' } } },
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
