// @vitest-environment jsdom
import { ProjectType } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ChatProjectPicker } from '@/app/routes/chat-with-ai/components/chat-project-picker';
import { TooltipProvider } from '@/components/ui/tooltip';

const CURRENT_USER_ID = 'currentUser1';

type TestProject = {
  id: string;
  displayName: string;
  type: ProjectType;
  ownerId: string;
};

let projects: TestProject[] = [];

vi.mock('@/features/projects', () => ({
  projectCollectionUtils: { useAll: () => ({ data: projects }) },
  getProjectName: (project: TestProject) =>
    project.type === ProjectType.PERSONAL
      ? 'Personal Project'
      : project.displayName,
}));

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getCurrentUserId: () => CURRENT_USER_ID },
}));

const personal: TestProject = {
  id: 'personal1',
  displayName: 'ignored',
  type: ProjectType.PERSONAL,
  ownerId: CURRENT_USER_ID,
};
const marketing: TestProject = {
  id: 'marketing1',
  displayName: 'Marketing',
  type: ProjectType.TEAM,
  ownerId: 'someoneElse',
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mountPicker = async ({
  projectId = null,
  onProjectChange = vi.fn(),
  locked = false,
}: {
  projectId?: string | null;
  onProjectChange?: (projectId: string) => void;
  locked?: boolean;
} = {}) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <ChatProjectPicker
          projectId={projectId}
          onProjectChange={onProjectChange}
          locked={locked}
        />
      </TooltipProvider>,
    );
  });
};

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const combobox = () =>
  document.querySelector<HTMLButtonElement>('button[role="combobox"]');

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
  projects = [];
});

describe('ChatProjectPicker', () => {
  it('renders nothing when the user has a single project to work in', async () => {
    projects = [personal];

    await mountPicker();

    expect(combobox()).toBeNull();
  });

  it('shows the personal project as the default before anything is picked', async () => {
    projects = [marketing, personal];

    await mountPicker();

    expect(combobox()?.textContent).toContain('Personal Project');
  });

  it('reports the picked project', async () => {
    projects = [personal, marketing];
    const onProjectChange = vi.fn();
    await mountPicker({ onProjectChange });

    await click(combobox()!);
    const item = [...document.querySelectorAll('[cmdk-item]')].find(
      (candidate) => (candidate.textContent ?? '').includes('Marketing'),
    );
    await click(item!);

    expect(onProjectChange).toHaveBeenCalledWith('marketing1');
  });

  it('is disabled once the conversation is locked to its project', async () => {
    projects = [personal, marketing];

    await mountPicker({ projectId: 'marketing1', locked: true });

    expect(combobox()?.textContent).toContain('Marketing');
    expect(combobox()?.disabled).toBe(true);
  });

  it('does not name the default for a locked conversation whose project is gone', async () => {
    projects = [personal, marketing];

    await mountPicker({ projectId: null, locked: true });

    expect(combobox()?.textContent).not.toContain('Personal Project');
  });
});
