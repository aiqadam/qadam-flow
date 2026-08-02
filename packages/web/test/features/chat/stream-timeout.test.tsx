// @vitest-environment jsdom
import { ChatAgentEventType, WebsocketClientEvent } from '@aiqadam/shared';
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

const PROMPT = 'how cold is this model';

const harness = vi.hoisted(() => {
  const socketHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const state = {
    conversationStatus: 'STREAMING',
    messages: [] as { role: string; parts: { type: string; text: string }[] }[],
    flags: {} as Record<string, number>,
    getMessagesCalls: 0,
  };
  return {
    state,
    socketHandlers,
    socket: {
      on: (event: string, listener: (payload: unknown) => void) => {
        const listeners = socketHandlers.get(event) ?? new Set();
        listeners.add(listener);
        socketHandlers.set(event, listeners);
      },
      off: (event: string, listener: (payload: unknown) => void) => {
        socketHandlers.get(event)?.delete(listener);
      },
    },
    chatApi: {
      createConversation: async () => ({ id: 'conv-1', modelName: null }),
      getConversation: async () => ({
        id: 'conv-1',
        modelName: null,
        status: state.conversationStatus,
      }),
      getMessages: async () => {
        state.getMessagesCalls++;
        return { data: state.messages };
      },
      sendMessage: async () => ({ conversationId: 'conv-1' }),
      getPendingGate: async () => null,
      cancelConversation: async () => undefined,
      updateConversation: async () => ({ id: 'conv-1' }),
    },
  };
});

vi.mock('@/components/providers/socket-provider', () => ({
  useSocket: () => harness.socket,
}));

vi.mock('@/features/chat/lib/chat-api', () => ({
  chatApi: harness.chatApi,
}));

vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: {
    useFlag: (flagId: string) => ({
      data: harness.state.flags[flagId] ?? null,
    }),
  },
}));

// The single bound the browser used to enforce for both waits, and the number this whole file is
// about: every wait below is chosen relative to it.
const OLD_FLAT_BOUND_MS = 2 * 60 * 1000;

function emitChatEvent(payload: Record<string, unknown>): void {
  const listeners =
    harness.socketHandlers.get(WebsocketClientEvent.CHAT_MESSAGE_CHUNK) ??
    new Set();
  for (const listener of [...listeners]) {
    listener(payload);
  }
}

function emitToken({ id, text }: { id: string; text: string }): void {
  emitChatEvent({
    conversationId: 'conv-1',
    type: ChatAgentEventType.CHUNK,
    data: [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
    ],
  });
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let chat: ReturnType<typeof useAgentChat> | undefined;

const Harness = () => {
  const agentChat = useAgentChat();
  chat = agentChat;
  return (
    <div>
      {agentChat.messages.map((message, index) => (
        <p key={index} data-role={message.role}>
          {message.parts
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')}
        </p>
      ))}
    </div>
  );
};

const mountChat = async (): Promise<void> => {
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
          <Harness />
        </ChatStoreProvider>
      </QueryClientProvider>,
    );
  });
};

const sendMessage = async (): Promise<void> => {
  await act(async () => {
    await chat?.sendMessage(PROMPT);
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const rendered = (): string => container?.textContent ?? '';

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  // Only the timers under test. Vitest's default set also fakes `queueMicrotask`, which React 19's
  // `act` flushes its work on, and the harness then renders nothing at all.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  harness.socketHandlers.clear();
  harness.state.conversationStatus = 'STREAMING';
  // The server persists the question before the run starts, so a tab that gives up and refetches
  // still has it. That makes "the late token is absent" an assertion about the token rather than
  // about an empty transcript.
  harness.state.messages = [
    { role: 'user', parts: [{ type: 'text', text: PROMPT }] },
  ];
  harness.state.getMessagesCalls = 0;
  harness.state.flags = {
    HTTP_FIRST_BYTE_TIMEOUT_SECONDS: 300,
    HTTP_STREAM_IDLE_TIMEOUT_SECONDS: 120,
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  chat = undefined;
  vi.useRealTimers();
});

describe('how long the open tab waits for a cold model', () => {
  it('renders a first token that arrives after the old flat two-minute bound', async () => {
    await mountChat();
    await sendMessage();

    await advance(OLD_FLAT_BOUND_MS + 10_000);
    emitToken({ id: 'text-1', text: 'the cold model finally answered' });
    await advance(200);

    expect(rendered()).toContain('the cold model finally answered');
  });

  it('renders a later token when the gap between chunks passes that bound too', async () => {
    await mountChat();
    await sendMessage();
    emitToken({ id: 'text-1', text: 'thinking about it' });
    await advance(200);

    await advance(OLD_FLAT_BOUND_MS + 30_000);
    emitToken({ id: 'text-2', text: 'and here is the rest' });
    await advance(200);

    expect(rendered()).toContain('thinking about it');
    expect(rendered()).toContain('and here is the rest');
  });

  it('waits as long as the operator configured the server to wait, not a literal of its own', async () => {
    harness.state.flags.HTTP_FIRST_BYTE_TIMEOUT_SECONDS = 900;
    await mountChat();
    await sendMessage();

    await advance(400_000);
    emitToken({ id: 'text-1', text: 'a very cold model finally answered' });
    await advance(200);

    expect(rendered()).toContain('a very cold model finally answered');
  });

  it('gives up once even the first-token allowance has passed', async () => {
    await mountChat();
    await sendMessage();

    await advance(400_000);
    emitToken({ id: 'text-1', text: 'far too late to matter' });
    await advance(200);

    expect(rendered()).toContain(PROMPT);
    expect(rendered()).not.toContain('far too late to matter');
  });

  it('holds the gap between chunks to a tighter bound than the wait for the first one', async () => {
    await mountChat();
    await sendMessage();
    emitToken({ id: 'text-1', text: 'thinking about it' });
    await advance(200);

    await advance(240_000);
    emitToken({ id: 'text-2', text: 'far too late to matter' });
    await advance(200);

    expect(rendered()).not.toContain('far too late to matter');
  });
});

describe('the fallback poll after a stream ends with no reply', () => {
  it('shows the answer in the open tab while the run is still going', async () => {
    await mountChat();
    await sendMessage();

    emitChatEvent({
      conversationId: 'conv-1',
      type: ChatAgentEventType.ERROR,
      data: { message: 'the socket dropped' },
    });
    await advance(100);
    expect(rendered()).not.toContain('the answer the tab never saw');

    harness.state.messages = [
      ...harness.state.messages,
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'the answer the tab never saw' }],
      },
    ];
    harness.state.conversationStatus = 'IDLE';
    await advance(6_000);

    expect(rendered()).toContain('the answer the tab never saw');
  });

  it('stops once the run has been silent for longer than the server keeps it', async () => {
    await mountChat();
    await sendMessage();

    emitChatEvent({
      conversationId: 'conv-1',
      type: ChatAgentEventType.ERROR,
      data: { message: 'the socket dropped' },
    });
    await advance(6_000);
    expect(harness.state.getMessagesCalls).toBeGreaterThan(1);

    await advance(6 * 60 * 1000);
    const callsOnceAbandoned = harness.state.getMessagesCalls;
    await advance(60_000);

    expect(harness.state.getMessagesCalls).toBe(callsOnceAbandoned);
  });
});
