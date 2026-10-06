// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CenteredPage } from '@/app/components/centered-page';
import { DashboardPageHeader } from '@/app/components/dashboard-page-header';
import { LockedFeatureGuard } from '@/app/components/locked-feature-guard';
import { PlatformSidebar } from '@/app/components/sidebar/platform';
import { SidebarProvider } from '@/components/ui/sidebar-shadcn';
import { useIsMobile } from '@/hooks/use-mobile';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({
      platform: {
        plan: {
          customAppearanceEnabled: true,
          globalConnectionsEnabled: true,
          managePiecesEnabled: true,
          manageTemplatesEnabled: true,
          embeddingEnabled: true,
          teamProjectsLimit: 'UNLIMITED',
          projectRolesEnabled: true,
          secretManagersEnabled: true,
          auditLogEnabled: true,
        },
      },
    }),
  },
}));

vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));

// SidebarUser pulls in user/telemetry/embedding providers unrelated to the sidebar toggle.
vi.mock('@/app/components/sidebar/sidebar-user', () => ({
  SidebarUser: () => null,
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom does not implement matchMedia, which useIsMobile subscribes to.
  Object.assign(window, {
    innerWidth: 390,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  document.body.innerHTML = '';
});

describe('platform layout on mobile', () => {
  // #714: DashboardPageHeader rendered PageHeader without showSidebarToggle, so platform
  // pages had no control to open the mobile Sheet.
  it('shows the sidebar toggle, which opens the platform sheet', async () => {
    await mount('users');
    expect(mobileSheet()).toBeNull();

    await act(async () => {
      toggleButton()?.click();
    });
    expect(mobileSheet()).not.toBeNull();
  });

  // #714: PlatformSidebar did not close the mobile Sheet on navigation, so the Sheet
  // stayed open over the page the user navigated to.
  it('closes the platform sheet when navigating from inside it', async () => {
    await mount('users');

    await act(async () => {
      toggleButton()?.click();
    });
    expect(mobileSheet()).not.toBeNull();

    await act(async () => {
      connectionsItem()?.click();
    });
    expect(pageText()).toContain('connections page');
    expect(mobileSheet()).toBeNull();
  });
  // #714: PlatformLayout pins SidebarProvider open, so a desktop toggle would write to a state
  // nothing renders from. It must not appear on desktop, where the layout is unchanged.
  it('shows no sidebar toggle on desktop, where the platform sidebar is pinned open', async () => {
    await mount('users', 1440);
    expect(toggleButton()).toBeNull();
    expect(mobileSheet()).toBeNull();
    expect(desktopState()).toBe('expanded');
  });

  // #716: four platform pages render CenteredPage instead of DashboardPageHeader, so without a
  // toggle the mobile Sheet could not be reopened on them (AI Providers is the exact #714 symptom).
  it('shows the sidebar toggle on a CenteredPage platform page', async () => {
    await mount('setup/ai');
    expect(mobileSheet()).toBeNull();

    await act(async () => {
      toggleButton()?.click();
    });
    expect(mobileSheet()).not.toBeNull();
  });

  // #716: plan-locked platform pages render LockedFeatureGuard instead of the page header, so the
  // toggle has to live on that lock screen too — Branding/Templates are reachable from the Sheet.
  it('shows the sidebar toggle on a locked platform page', async () => {
    await mount('setup/branding');
    expect(mobileSheet()).toBeNull();

    await act(async () => {
      toggleButton()?.click();
    });
    expect(mobileSheet()).not.toBeNull();
  });
});

async function mount(page: string, width = 390): Promise<void> {
  // useIsMobile reads window.innerWidth when the header mounts.
  Object.assign(window, { innerWidth: width });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[`/platform/${page}`]}>
        <Routes>
          <Route
            path="/platform/users"
            element={<PlatformHarness page="users" />}
          />
          <Route
            path="/platform/connections"
            element={<PlatformHarness page="connections" />}
          />
          <Route
            path="/platform/setup/ai"
            element={<CenteredHarness page="setup/ai" />}
          />
          <Route
            path="/platform/setup/branding"
            element={<LockedHarness page="setup/branding" />}
          />
        </Routes>
      </MemoryRouter>,
    );
  });
}

// Mirrors PlatformLayout: both platform routes render here, so React keeps the same
// SidebarProvider (and its `openMobile` state) mounted across the navigation.
function PlatformHarness({ page }: { page: string }) {
  return (
    <SidebarProvider open={true}>
      <PlatformSidebar />
      <DashboardPageHeader title={page} />
      <p>{page} page</p>
    </SidebarProvider>
  );
}

// Mirrors the CenteredPage platform pages, which gate the toggle on isMobile themselves (#716).
function CenteredHarness({ page }: { page: string }) {
  const isMobile = useIsMobile();
  return (
    <SidebarProvider open={true}>
      <PlatformSidebar />
      <CenteredPage
        title={page}
        description={page}
        showSidebarToggle={isMobile}
      >
        <p>{page} page</p>
      </CenteredPage>
    </SidebarProvider>
  );
}

// Mirrors a plan-locked platform page, which renders the toggle on the LockedFeatureGuard (#716).
function LockedHarness({ page }: { page: string }) {
  const isMobile = useIsMobile();
  return (
    <SidebarProvider open={true}>
      <PlatformSidebar />
      <LockedFeatureGuard
        locked={true}
        lockTitle={page}
        lockDescription={page}
        showSidebarToggle={isMobile}
      >
        <p>{page} page</p>
      </LockedFeatureGuard>
    </SidebarProvider>
  );
}

function toggleButton(): HTMLButtonElement | null {
  return (
    container?.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-toggle"]',
    ) ?? null
  );
}

function desktopState(): string | null {
  return (
    document
      .querySelector('.peer[data-slot="sidebar"]')
      ?.getAttribute('data-state') ?? null
  );
}

function connectionsItem(): HTMLElement | null {
  return (
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Connections',
    ) ?? null
  );
}

function mobileSheet(): Element | null {
  return document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
}

// No jest-dom in this harness, so read the text directly.
function pageText(): string {
  return document.body.textContent ?? '';
}
