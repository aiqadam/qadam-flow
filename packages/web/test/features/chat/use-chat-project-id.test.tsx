// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ChatStoreProvider } from '@/features/chat/lib/chat-store-context';
import { useAgentChat } from '@/features/chat/lib/use-chat';

// The project picker's contract with the hook: a pick made before the first message reaches
// `createConversation`, the project the picker shows by default is sent explicitly rather than left
// to the server's own fallback, and a repin the server refuses leaves the picker on the project the
// row still holds.
const harness = vi.hoisted(() => {
  const createConversationCalls: { projectId?: string | null }[] = [];
  const updateConversationCalls: {
    id: string;
    body: { projectId?: string | null };
  }[] = [];
  let updateConversationShouldFail = false;
  return {
    createConversationCalls,
    updateConversationCalls,
    setUpdateConversationShouldFail: (value: boolean) => {
      updateConversationShouldFail = value;
    },
    socket: {
      on: () => undefined,
      off: () => undefined,
    },
    chatApi: {
      createConversation: async (body: { projectId?: string | null }) => {
        createConversationCalls.push(body);
        return {
          id: 'conv-1',
          modelName: null,
          projectId: body.projectId ?? null,
        };
      },
      getConversation: async () => ({
        id: 'conv-1',
        modelName: null,
        projectId: 'pinned-project',
        status: 'IDLE',
      }),
      getMessages: async () => ({ data: [] }),
      sendMessage: async () => ({ conversationId: 'conv-1' }),
      getPendingGate: async () => null,
      cancelConversation: async () => undefined,
      updateConversation: async (
        id: string,
        body: { projectId?: string | null },
      ) => {
        updateConversationCalls.push({ id, body });
        if (updateConversationShouldFail) {
          throw new Error('conflict');
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

const Harness = ({ defaultProjectId }: { defaultProjectId: string | null }) => {
  const agentChat = useAgentChat({ defaultProjectId });
  chat = agentChat;
  return <div>{agentChat.projectId ?? 'none'}</div>;
};

const mountChat = async (
  defaultProjectId: string | null = 'default-project',
): Promise<void> => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ChatStoreProvider>
          <Harness defaultProjectId={defaultProjectId} />
        </ChatStoreProvider>
      </QueryClientProvider>,
    );
  });
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  harness.createConversationCalls.length = 0;
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

describe('useAgentChat — project', () => {
  it('sends the default project when the conversation is created without a pick', async () => {
    await mountChat('default-project');

    await act(async () => {
      await chat?.sendMessage('hello');
    });

    expect(harness.createConversationCalls).toEqual([
      expect.objectContaining({ projectId: 'default-project' }),
    ]);
  });

  it('keeps a pick made before the first message local, then creates the conversation in it', async () => {
    await mountChat('default-project');

    await act(async () => {
      await chat?.setProjectId('picked-project');
    });
    expect(chat?.projectId).toBe('picked-project');
    expect(harness.updateConversationCalls).toEqual([]);

    await act(async () => {
      await chat?.sendMessage('hello');
    });

    expect(harness.createConversationCalls).toEqual([
      expect.objectContaining({ projectId: 'picked-project' }),
    ]);
  });

  it('restores the pinned project when an existing conversation is opened', async () => {
    await mountChat();

    await act(async () => {
      await chat?.setConversationId('conv-1');
    });

    expect(chat?.projectId).toBe('pinned-project');
  });

  it('surfaces a refused repin and stays on the project the row still holds', async () => {
    await mountChat();
    await act(async () => {
      await chat?.setConversationId('conv-1');
    });
    harness.setUpdateConversationShouldFail(true);

    await act(async () => {
      await chat?.setProjectId('another-project');
    });

    expect(harness.updateConversationCalls).toEqual([
      { id: 'conv-1', body: { projectId: 'another-project' } },
    ]);
    expect(harness.toastError).toHaveBeenCalledTimes(1);
    expect(chat?.projectId).toBe('pinned-project');
  });
});
