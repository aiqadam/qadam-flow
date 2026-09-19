// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatStoreProvider } from '@/features/chat/lib/chat-store-context';
import { useAgentChat } from '@/features/chat/lib/use-chat';

// Covers the wiring #377 makes reachable for the first time: a model picked through the UI must
// actually reach `chatApi.updateConversation`, and a failed write must not leave the picker
// showing a model the conversation row never switched to (the gap code-quality review flagged —
// the old implementation flipped local state before the request settled and swallowed a failure
// with `.catch(() => undefined)`).
const harness = vi.hoisted(() => {
  const updateConversationCalls: { id: string; body: { modelName?: string | null } }[] = [];
  let updateConversationShouldFail = false;
  return {
    updateConversationCalls,
    setUpdateConversationShouldFail: (value: boolean) => {
      updateConversationShouldFail = value;
    },
    socket: {
      on: () => undefined,
      off: () => undefined,
    },
    chatApi: {
      createConversation: async () => ({ id: 'conv-1', modelName: null }),
      getConversation: async () => ({ id: 'conv-1', modelName: 'starting-model', status: 'IDLE' }),
      getMessages: async () => ({ data: [] }),
      sendMessage: async () => ({ conversationId: 'conv-1' }),
      getPendingGate: async () => null,
      cancelConversation: async () => undefined,
      updateConversation: async (id: string, body: { modelName?: string | null }) => {
        updateConversationCalls.push({ id, body });
        if (updateConversationShouldFail) {
          throw new Error('network error');
        }
        return { id };
      },
    },
    toastError: vi.fn(),
  };
});

vi.mock('@/components/providers/socket-provider', () => ({
  useSocket: () => harness.socket,
}));

vi.mock('@/features/chat/lib/chat-api', () => ({
  chatApi: harness.chatApi,
}));

vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: null }) },
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => harness.toastError(...args) },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let chat: ReturnType<typeof useAgentChat> | undefined;

const Harness = () => {
  const agentChat = useAgentChat();
  chat = agentChat;
  return <div>{agentChat.modelName ?? 'none'}</div>;
};

const mountChat = async (): Promise<void> => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ChatStoreProvider>
          <Harness />
        </ChatStoreProvider>
      </QueryClientProvider>,
    );
  });
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  harness.updateConversationCalls.length = 0;
  harness.setUpdateConversationShouldFail(false);
  harness.toastError.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  chat = undefined;
});

describe('useAgentChat — setModelName', () => {
  it('updates only local state before any conversation exists, with no API call', async () => {
    await mountChat();

    await act(async () => {
      await chat?.setModelName('picked-before-first-message');
    });

    expect(chat?.modelName).toBe('picked-before-first-message');
    expect(harness.updateConversationCalls).toEqual([]);
  });

  it('persists the pick to the existing conversation and reflects it once the write succeeds', async () => {
    await mountChat();
    await act(async () => {
      await chat?.setConversationId('conv-1');
    });

    await act(async () => {
      await chat?.setModelName('gpt-5');
    });

    expect(harness.updateConversationCalls).toEqual([
      { id: 'conv-1', body: { modelName: 'gpt-5' } },
    ]);
    expect(chat?.modelName).toBe('gpt-5');
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it('surfaces a failure and does not adopt a model the row never actually switched to', async () => {
    await mountChat();
    await act(async () => {
      await chat?.setConversationId('conv-1');
    });
    expect(chat?.modelName).toBe('starting-model');
    harness.setUpdateConversationShouldFail(true);

    await act(async () => {
      await chat?.setModelName('gpt-5');
    });

    expect(harness.toastError).toHaveBeenCalledTimes(1);
    // The write was attempted and rejected — local state must stay at what the row actually holds.
    expect(chat?.modelName).toBe('starting-model');
  });
});
