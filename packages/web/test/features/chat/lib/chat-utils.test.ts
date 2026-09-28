import { describe, expect, it } from 'vitest';

import { ChatUIMessage } from '@/features/chat/lib/chat-types';
import { chatUtils } from '@/features/chat/lib/chat-utils';

const history: ChatUIMessage[] = [
  message({ id: 'hist-0', role: 'user' }),
  message({ id: 'hist-1', role: 'assistant' }),
];

describe('chatUtils.messagesWindowedByRun', () => {
  it('leaves the list alone between runs, since that is what the next send windows', () => {
    expect(
      chatUtils.messagesWindowedByRun({
        messages: history,
        isStreaming: false,
      }),
    ).toBe(history);
  });

  it('sets aside a just-sent user turn while it is being submitted', () => {
    const messages = [...history, message({ id: 'optimistic', role: 'user' })];

    expect(
      chatUtils.messagesWindowedByRun({ messages, isStreaming: true }),
    ).toEqual(history);
  });

  it('sets aside the reply in flight and the user turn it answers', () => {
    const messages = [
      ...history,
      message({ id: 'optimistic', role: 'user' }),
      message({ id: 'streaming', role: 'assistant' }),
    ];

    expect(
      chatUtils.messagesWindowedByRun({ messages, isStreaming: true }),
    ).toEqual(history);
  });

  it('keeps the gate a resumed run was sent, setting aside only its reply', () => {
    const gate = message({ id: 'hist-2', role: 'assistant' });
    const messages = [
      ...history,
      gate,
      message({ id: 'streaming', role: 'assistant' }),
    ];

    expect(
      chatUtils.messagesWindowedByRun({ messages, isStreaming: true }),
    ).toEqual([...history, gate]);
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
