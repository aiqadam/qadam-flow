// @vitest-environment jsdom
import { ErrorCode } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CHAT_SERVICE_UNAVAILABLE,
  ChatSendingError,
  ErrorBubble,
  FLOW_RUN_FAILED,
  FLOW_STILL_RUNNING,
} from '@/features/chat/chat-message-list/error-bubble';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mountBubble = async ({
  sendingError,
  sendMessage = vi.fn(),
}: {
  sendingError: ChatSendingError;
  sendMessage?: (arg0: { isRetrying: boolean }) => void;
}) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ErrorBubble
        chatUI={null}
        flowId="flow-1"
        sendingError={sendingError}
        sendMessage={sendMessage}
      />,
    );
  });
};

describe('ErrorBubble', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  it('tells the user a timed-out flow is still running and offers no retry', async () => {
    await mountBubble({ sendingError: { code: FLOW_STILL_RUNNING } });

    expect(container?.textContent).toContain(
      'The flow is still running and did not reply in time.',
    );
    // A retry would start the still-running flow a second time.
    expect(container?.querySelector('button')).toBeNull();
  });

  it('keeps the retry action on an ordinary failure', async () => {
    const sendMessage = vi.fn();
    await mountBubble({
      sendingError: { code: ErrorCode.NO_CHAT_RESPONSE, params: {} },
      sendMessage,
    });

    const retry = container?.querySelector('button');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sendMessage).toHaveBeenCalledWith({ isRetrying: true });
  });

  it('tells the user the flow run itself failed, and offers a retry', async () => {
    await mountBubble({ sendingError: { code: FLOW_RUN_FAILED } });

    expect(container?.textContent).toContain('The flow failed to execute.');
    expect(container?.querySelector('button')).not.toBeNull();
  });

  it('tells the user the service is overloaded, and offers a retry', async () => {
    await mountBubble({ sendingError: { code: CHAT_SERVICE_UNAVAILABLE } });

    expect(container?.textContent).toContain(
      'The service is temporarily busy. Please try again in a moment.',
    );
    expect(container?.querySelector('button')).not.toBeNull();
  });
});
