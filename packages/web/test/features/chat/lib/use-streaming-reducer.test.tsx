// @vitest-environment jsdom
import { ChatAgentEventType, WebsocketClientEvent } from '@aiqadam/shared';
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

import { chatUtils } from '@/features/chat/lib/chat-utils';
import { useStreamingReducer } from '@/features/chat/lib/use-streaming-reducer';

const harness = vi.hoisted(() => {
  const socketHandlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
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
  };
});

vi.mock('@/components/providers/socket-provider', () => ({
  useSocket: () => harness.socket,
}));

vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: null }) },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let streaming: ReturnType<typeof useStreamingReducer> | undefined;

const Harness = () => {
  streaming = useStreamingReducer({
    onTitleUpdate: vi.fn(),
    onToolProgress: vi.fn(),
    onToolApprovalRequest: vi.fn(),
    onActionPreview: vi.fn(),
    onActionReceipt: vi.fn(),
    onStreamFinished: vi.fn(),
    onStreamError: vi.fn(),
    onStaleCheck: vi.fn(),
  });
  return null;
};

function emitChunks(chunks: Record<string, unknown>[]): void {
  const listeners =
    harness.socketHandlers.get(WebsocketClientEvent.CHAT_MESSAGE_CHUNK) ??
    new Set();
  for (const listener of [...listeners]) {
    listener({
      conversationId: 'conv-1',
      type: ChatAgentEventType.CHUNK,
      data: chunks,
    });
  }
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const mountHarness = async (): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
};

beforeEach(() => {
  harness.socketHandlers.clear();
  vi.useFakeTimers({
    toFake: [
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  streaming = undefined;
  vi.useRealTimers();
});

// #564. The reducer is timed by the hook, so this is the one place that proves the arrival time
// reaches it: each socket batch is stamped as it lands, not when the throttled flush applies it.
describe('useStreamingReducer — thinking duration', () => {
  it('times the live reply from the start chunk to the first text, by arrival', async () => {
    await mountHarness();
    act(() => streaming?.startStream('conv-1'));

    // `start` waits the full 100 ms throttle; the text lands 50 ms into a flush the reasoning
    // already scheduled. Stamped at the flush, the two lags differ and the figure reads 2950.
    act(() => emitChunks([{ type: 'start' }]));
    await act(async () => {
      vi.advanceTimersByTime(2_950);
    });
    act(() => emitChunks([{ type: 'reasoning-start', id: 'r1' }]));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    act(() =>
      emitChunks([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hi' },
      ]),
    );
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const message = streaming?.streamingMessage;
    if (!message) throw new Error('no streaming message');
    expect(chatUtils.thinkingDurationOf(message)).toBe(3_000);
  });
});
