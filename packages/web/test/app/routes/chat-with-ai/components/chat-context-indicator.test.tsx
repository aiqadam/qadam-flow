// @vitest-environment jsdom
import { ChatContextUsage } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ChatContextIndicator } from '@/app/routes/chat-with-ai/components/chat-context-indicator';

// Interpolates the arguments too, so a test can tell "81k of 200k" from the numbers swapped.
// i18next is not initialised in this harness, so plural arguments stay as written.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string, args?: Record<string, unknown>) =>
    Object.entries(args ?? {}).reduce(
      (message, [name, value]) =>
        message.replaceAll(`{${name}}`, String(value)),
      key,
    ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const compactionOn = { autoCompact: true, compactedSinceMeasured: false };

const openIndicator = async (
  props: Omit<
    React.ComponentProps<typeof ChatContextIndicator>,
    'compaction'
  > & {
    compaction?: React.ComponentProps<typeof ChatContextIndicator>['compaction'];
  },
): Promise<{ trigger: string; content: string }> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ChatContextIndicator compaction={compactionOn} {...props} />,
    );
  });
  const button = container.querySelector('button');
  if (!button) throw new Error('context indicator not rendered');
  const trigger = button.textContent ?? '';
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // The popover portals to the body, outside the container.
  return { trigger, content: document.body.textContent ?? '' };
};

const measured: ChatContextUsage = {
  modelId: 'claude-sonnet-4',
  usedTokens: 81_000,
  contextWindowTokens: 200_000,
  breakdown: {
    systemPrompt: 7_000,
    tools: 16_000,
    toolCount: 51,
    messages: 13_000,
    toolOutputs: 45_000,
  },
};

describe('ChatContextIndicator', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  it('shows how full the context is on the button itself', async () => {
    const { trigger } = await openIndicator({ usage: measured, hasReply: true });

    expect(trigger).toBe('Context · 41%');
  });

  it('shows the total against the window, what filled it, and what is left', async () => {
    const { content } = await openIndicator({ usage: measured, hasReply: true });

    expect(content).toContain('claude-sonnet-4 · window 200k');
    expect(content).toContain('81k of 200k · 41%');
    expect(content).toContain('System prompt≈ 7k');
    expect(content).toContain('≈ 16k');
    expect(content).toContain('Messages≈ 13k');
    expect(content).toContain('Tool outputs≈ 45k');
    // Free is arithmetic on two real numbers, not an estimate.
    expect(content).toContain('Free119k');
  });

  it('says when the window is assumed rather than known', async () => {
    const { content } = await openIndicator({
      usage: { ...measured, contextWindowTokens: null },
      hasReply: true,
    });

    expect(content).toContain('claude-sonnet-4 · window not set, assuming 128k');
    expect(content).toContain('81k of 128k · 63%');
  });

  it('never shows more than a full context, or negative room', async () => {
    const { trigger, content } = await openIndicator({
      usage: { ...measured, usedTokens: 150_000, contextWindowTokens: null },
      hasReply: true,
    });

    expect(trigger).toBe('Context · 100%');
    expect(content).toContain('Free0');
  });

  it('shows no number before the first reply has been measured', async () => {
    const { trigger, content } = await openIndicator({
      usage: null,
      hasReply: false,
    });

    expect(trigger).toBe('Context');
    expect(content).toContain('Shows up once a reply finishes.');
  });

  it('says the provider reported nothing rather than inventing a figure', async () => {
    const { content } = await openIndicator({ usage: null, hasReply: true });

    expect(content).toContain(
      'No measurement for the last reply. It appears after the next one, if the provider reports token usage.',
    );
    expect(content).not.toContain('%');
  });

  it('says how far the context is from the next auto-compact and from overflowing', async () => {
    const { content } = await openIndicator({ usage: measured, hasReply: true });

    // Fixed 23k, room 177k, compacts at 23k + 60% of 177k = 129.2k: 48.2k to go from 81k.
    expect(content).toContain('Until auto-compact ≈ 48.2k · until overflow 119k');
  });

  it('says compaction is next once the reply went past the threshold', async () => {
    const { content } = await openIndicator({
      usage: { ...measured, usedTokens: 150_000 },
      hasReply: true,
    });

    expect(content).toContain('Compacts after this reply · until overflow 50k');
  });

  it('shows the summary as its own part once there is one', async () => {
    const { content } = await openIndicator({
      usage: { ...measured, breakdown: { ...measured.breakdown, summary: 1_000 } },
      hasReply: true,
    });

    expect(content).toContain('Summary≈ 1k');
  });

  it('says auto-compact is off instead of counting down to it', async () => {
    const { content } = await openIndicator({
      usage: measured,
      hasReply: true,
      compaction: { autoCompact: false, compactedSinceMeasured: false },
    });

    expect(content).toContain('Auto-compact off · until overflow 119k');
    expect(content).toContain(
      'Older messages are dropped, not summarised, when the context fills up.',
    );
  });

  it('warns that the figures predate a compaction pass', async () => {
    const { content } = await openIndicator({
      usage: measured,
      hasReply: true,
      compaction: { autoCompact: true, compactedSinceMeasured: true },
    });

    expect(content).toContain('History was compacted after this reply.');
  });

  it('turns auto-compact off from the switch', async () => {
    const onAutoCompactChange = vi.fn();
    await openIndicator({ usage: measured, hasReply: true, onAutoCompactChange });

    const toggle = document.getElementById('chat-auto-compact');
    if (!toggle) throw new Error('auto-compact switch not rendered');
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onAutoCompactChange).toHaveBeenCalledWith(false);
  });
});
