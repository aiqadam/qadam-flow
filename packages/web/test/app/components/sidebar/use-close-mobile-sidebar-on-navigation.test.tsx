// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useCloseMobileSidebarOnNavigation } from '@/app/components/sidebar/use-close-mobile-sidebar-on-navigation';
import { ApSidebarToggle } from '@/components/custom/ap-sidebar-toggle';
import { Sidebar, SidebarProvider } from '@/components/ui/sidebar-shadcn';

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

describe('useCloseMobileSidebarOnNavigation', () => {
  // /impact and /leaderboard both render a bare <ProjectDashboardLayout>, so React keeps
  // the same SidebarProvider across the navigation and its `openMobile` state with it.
  it('closes the mobile sheet when navigating between routes that share a layout', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={['/impact']}>
          <Routes>
            <Route path="/impact" element={<Layout page="impact" />} />
            <Route path="/leaderboard" element={<Layout page="leaderboard" />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(document.body.textContent).toContain('impact page');

    await act(async () => {
      container?.querySelector('button')?.click();
    });
    expect(mobileSheet()).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLAnchorElement>('a[href="/leaderboard"]')
        ?.click();
    });
    expect(document.body.textContent).toContain('leaderboard page');
    expect(mobileSheet()).toBeNull();
  });
});

function Layout({ page }: { page: string }) {
  return (
    <SidebarProvider hoverMode={true}>
      <AppSidebar />
      <ApSidebarToggle />
      <p>{page} page</p>
    </SidebarProvider>
  );
}

function AppSidebar() {
  useCloseMobileSidebarOnNavigation();
  return (
    <Sidebar collapsible="icon">
      <Link to="/leaderboard">Leaderboard</Link>
    </Sidebar>
  );
}

function mobileSheet(): Element | null {
  return document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
}
