// @vitest-environment jsdom
import { ProjectType } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ChatContextIndicator } from '@/app/routes/chat-with-ai/components/chat-context-indicator';
import { TooltipProvider } from '@/components/ui/tooltip';

const CURRENT_USER_ID = 'currentUser1';

// Interpolates the arguments too, so a test can tell "Latest 20 of 25" from a message with the
// numbers swapped. i18next is not initialised in this harness.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string, args?: Record<string, unknown>) =>
    Object.entries(args ?? {}).reduce(
      (message, [name, value]) =>
        message.replaceAll(`{${name}}`, String(value)),
      key,
    ),
}));

const personal = {
  id: 'personal1',
  displayName: 'ignored',
  type: ProjectType.PERSONAL,
  ownerId: CURRENT_USER_ID,
};
const marketing = {
  id: 'marketing1',
  displayName: 'Marketing',
  type: ProjectType.TEAM,
  ownerId: 'someoneElse',
};

vi.mock('@/features/projects', () => ({
  projectCollectionUtils: {
    useAll: () => ({ data: [personal, marketing] }),
  },
  getProjectName: (project: { type: ProjectType; displayName: string }) =>
    project.type === ProjectType.PERSONAL
      ? 'Personal Project'
      : project.displayName,
}));

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => CURRENT_USER_ID },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const openIndicator = async (
  props: React.ComponentProps<typeof ChatContextIndicator>,
) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <ChatContextIndicator {...props} />
      </TooltipProvider>,
    );
  });
  const button = container.querySelector('button');
  if (!button) throw new Error('context indicator not rendered');
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // The popover portals to the body, outside the container.
  return document.body.textContent ?? '';
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

  it('names the pinned project and says every message is still sent', async () => {
    const shown = await openIndicator({
      projectId: marketing.id,
      isProjectLocked: true,
      totalMessages: 6,
      replayedMessages: 6,
    });

    expect(shown).toContain('Marketing');
    expect(shown).not.toContain('Latest');
    expect(shown).not.toContain('Older messages are no longer sent');
  });

  it('says how many messages the model still sees once the window has trimmed the rest', async () => {
    const shown = await openIndicator({
      projectId: marketing.id,
      isProjectLocked: true,
      totalMessages: 25,
      replayedMessages: 20,
    });

    expect(shown).toContain('Latest 20 of 25');
    expect(shown).toContain('Older messages are no longer sent to the model.');
  });

  it('names the default project before the conversation has pinned one', async () => {
    const shown = await openIndicator({
      projectId: null,
      isProjectLocked: false,
      totalMessages: 1,
      replayedMessages: 1,
    });

    expect(shown).toContain('Personal Project');
  });

  it('does not claim a project for a locked conversation that lost its project', async () => {
    const shown = await openIndicator({
      projectId: null,
      isProjectLocked: true,
      totalMessages: 4,
      replayedMessages: 4,
    });

    expect(shown).toContain('No project');
    expect(shown).not.toContain('Personal Project');
  });

  it('says reasoning is not carried into later turns', async () => {
    const shown = await openIndicator({
      projectId: marketing.id,
      isProjectLocked: true,
      totalMessages: 2,
      replayedMessages: 2,
    });

    expect(shown).toContain(
      'Reasoning from earlier replies is not sent back to the model.',
    );
  });
});
