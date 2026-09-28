// @vitest-environment jsdom
import {
  PersistedChatMessage,
  PersistedChatPartType,
  PersistedChatRole,
} from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ThinkingBlock } from '@/app/routes/chat-with-ai/components/activity-accordion';
import { AssistantMessage } from '@/app/routes/chat-with-ai/components/assistant-message';
import { ChatStoreProvider } from '@/features/chat/lib/chat-store-context';
import { ChatUIMessage } from '@/features/chat/lib/chat-types';
import { chatUtils } from '@/features/chat/lib/chat-utils';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

const REASONING =
  'The user wants a Slack step, so look up the connection first.';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mount = async (node: React.ReactNode) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
};

const trigger = (): HTMLButtonElement => {
  const button = container?.querySelector<HTMLButtonElement>(
    '[data-slot="collapsible-trigger"]',
  );
  if (!button) throw new Error('thinking block trigger not rendered');
  return button;
};

// Read through a helper rather than asserted with `toHaveAttribute`: no test file here registers
// `@testing-library/jest-dom`, so its matchers do not exist in this harness.
const isExpanded = () => trigger().getAttribute('aria-expanded') === 'true';

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const text = () => container?.textContent ?? '';

describe('ThinkingBlock', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  it('hides the reasoning until the trigger is clicked, and hides it again on a second click', async () => {
    await mount(
      <ThinkingBlock
        thinkingSteps={[{ kind: 'reasoning', text: REASONING }]}
        reasoningText={REASONING}
        isStreaming={false}
      />,
    );

    expect(text()).not.toContain(REASONING);
    expect(isExpanded()).toBe(false);

    await click(trigger());
    expect(text()).toContain(REASONING);
    expect(isExpanded()).toBe(true);

    await click(trigger());
    expect(text()).not.toContain(REASONING);
    expect(isExpanded()).toBe(false);
  });

  it('reports every toggle to the parent', async () => {
    const onOpenChange = vi.fn();
    await mount(
      <ThinkingBlock
        thinkingSteps={[{ kind: 'reasoning', text: REASONING }]}
        reasoningText={REASONING}
        isStreaming={false}
        onOpenChange={onOpenChange}
      />,
    );

    await click(trigger());
    await click(trigger());

    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('cannot be opened while there is nothing to show', async () => {
    await mount(
      <ThinkingBlock thinkingSteps={[]} reasoningText="" isStreaming={true} />,
    );

    expect(trigger().disabled).toBe(true);
    await click(trigger());
    expect(isExpanded()).toBe(false);
  });
});

describe('AssistantMessage reasoning', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  const mountMessage = (message: ChatUIMessage, isStreaming: boolean) =>
    mount(
      <ChatStoreProvider>
        <AssistantMessage
          message={message}
          isStreaming={isStreaming}
          onRetry={vi.fn()}
        />
      </ChatStoreProvider>,
    );

  it('keeps persisted reasoning reachable after a reload, behind the collapsed block', async () => {
    const persisted: PersistedChatMessage[] = [
      {
        role: PersistedChatRole.ASSISTANT,
        parts: [
          { type: PersistedChatPartType.REASONING, text: REASONING },
          { type: PersistedChatPartType.TEXT, text: 'Here is the flow.' },
        ],
      },
    ];
    const [message] = chatUtils.mapHistoryToUIMessages(persisted);

    await mountMessage(message, false);

    expect(text()).toContain('Here is the flow.');
    expect(text()).not.toContain(REASONING);

    await click(trigger());
    expect(text()).toContain(REASONING);
  });

  it('shows reasoning as it streams, before any reply text arrives', async () => {
    await mountMessage(
      {
        id: 'live-1',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: REASONING }],
      },
      true,
    );

    expect(text()).toContain('Thinking...');
    expect(text()).toContain(REASONING);
    expect(isExpanded()).toBe(false);
  });
});
