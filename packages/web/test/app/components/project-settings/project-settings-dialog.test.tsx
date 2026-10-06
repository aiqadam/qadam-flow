// @vitest-environment jsdom
import { PlatformRole, ProjectType } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProjectSettingsDialog } from '@/app/components/project-settings';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

// The shell is what this test exercises; every tab body pulls its own data hooks, so they are
// stubbed to keep the mount to the layout decision under test.
vi.mock('@/app/components/project-settings/general', () => ({
  GeneralSettings: () => <div data-testid="general-tab-body" />,
}));
vi.mock('@/app/components/project-settings/environment', () => ({
  EnvironmentSettings: () => <div data-testid="environment-tab-body" />,
}));
vi.mock('@/app/components/project-settings/mcp-server', () => ({
  McpServerSettings: () => <div data-testid="mcp-tab-body" />,
}));
vi.mock('@/app/components/project-settings/qadams', () => ({
  PiecesSettings: () => <div data-testid="pieces-tab-body" />,
}));
vi.mock('@/features/invitations/components/project-members-tab', () => ({
  ProjectMembersTab: () => <div data-testid="team-tab-body" />,
}));
vi.mock('@/features/projects/components/ap-project-display', () => ({
  ApProjectDisplay: () => <div data-testid="project-display" />,
}));
vi.mock('@/app/components/project-avatar', () => ({
  ProjectAvatar: () => <div data-testid="project-avatar" />,
}));

vi.mock('@/features/projects', () => ({
  projectCollectionUtils: {
    useCurrentProject: () => ({
      project: {
        id: 'project-1',
        displayName: 'Test Project',
        icon: { color: 'blue' },
        type: ProjectType.TEAM,
        maxConcurrentJobs: null,
        defaultLocale: null,
      },
    }),
    update: vi.fn(),
  },
}));

vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));

vi.mock('@/hooks/user-hooks', () => ({
  userHooks: { getCurrentUserPlatformRole: () => PlatformRole.ADMIN },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const mount = async ({ width }: { width: number }): Promise<void> => {
  // useIsMobile reads window.innerWidth when it mounts; matchMedia only supplies the change
  // subscription, which jsdom does not implement.
  Object.assign(window, { innerWidth: width });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ProjectSettingsDialog open={true} onClose={() => {}} />);
  });
  await flush();
};

const desktopNav = (): Element | null =>
  document.querySelector('[data-testid="project-settings-desktop-nav"]');

const mobileNav = (): Element | null =>
  document.querySelector('[data-testid="project-settings-mobile-nav"]');

const tab = (id: string): Element | null =>
  document.querySelector(`[data-testid="project-settings-tab-${id}"]`);

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  // Radix portals the dialog body outside the container, so unmounting alone leaves it behind.
  document.body.replaceChildren();
  container = undefined;
  root = undefined;
});

describe('ProjectSettingsDialog navigation layout', () => {
  it('swaps the fixed side column for a top tab strip below the 768px breakpoint', async () => {
    await mount({ width: 390 });

    expect(mobileNav()).not.toBeNull();
    expect(desktopNav()).toBeNull();
    expect(tab('general')?.tagName).toBe('BUTTON');
  });

  it('keeps the fixed 238px side column at desktop widths', async () => {
    await mount({ width: 1440 });

    const desktop = desktopNav();
    expect(desktop).not.toBeNull();
    expect(desktop?.className).toContain('w-[238px]');
    expect(mobileNav()).toBeNull();
    expect(tab('general')).not.toBeNull();
  });

  it('switches tab content from the mobile strip', async () => {
    await mount({ width: 390 });
    expect(document.querySelector('[data-testid="general-tab-body"]')).not.toBeNull();

    await act(async () => {
      // Radix activates a tab on mousedown, which Playwright's real click also produces.
      tab('team')?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
    });
    await flush();

    expect(document.querySelector('[data-testid="team-tab-body"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="general-tab-body"]')).toBeNull();
  });
});
