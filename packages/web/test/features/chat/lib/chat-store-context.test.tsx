// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chatStoreSelectors } from '@/features/chat/lib/chat-store';
import {
  ChatStoreProvider,
  useChatStoreContext,
} from '@/features/chat/lib/chat-store-context';

// zustand v5 dropped the equality parameter and compares the snapshot with `Object.is`, so a
// selector that builds a new array/object on every call forces an update until React throws
// `Maximum update depth exceeded`. `useChatStoreContext` wraps its selector in `useShallow` to
// keep the snapshot stable. These tests render a real store through that wrapper: without the
// `useShallow` the mounts below throw, so they fail loudly if it is ever removed.
let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mount = async (node: React.ReactNode): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  container = undefined;
  root = undefined;
});

describe('useChatStoreContext with a fresh-reference selector', () => {
  it('renders a selector that returns a new array instead of looping', async () => {
    const Probe = () => {
      const [quickReplies, conversationId] = useChatStoreContext((s) => [
        s.quickReplies,
        s.conversationId,
      ]);
      return (
        <span>
          {quickReplies.length}:{String(conversationId)}
        </span>
      );
    };

    await mount(
      <ChatStoreProvider>
        <Probe />
      </ChatStoreProvider>,
    );

    expect(container?.textContent).toBe('0:null');
  });

  it('renders `activeQuestions`, which returns a fresh empty array when there is no message', async () => {
    const Probe = () => {
      const questions = useChatStoreContext((s) =>
        chatStoreSelectors.activeQuestions({
          state: s,
          lastAssistantMessage: undefined,
        }),
      );
      return <span>{questions.length}</span>;
    };

    await mount(
      <ChatStoreProvider>
        <Probe />
      </ChatStoreProvider>,
    );

    expect(container?.textContent).toBe('0');
  });
});
