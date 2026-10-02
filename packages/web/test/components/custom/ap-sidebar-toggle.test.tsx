// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApSidebarToggle } from '@/components/custom/ap-sidebar-toggle';
import { Sidebar, SidebarProvider } from '@/components/ui/sidebar-shadcn';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mount = async ({ width }: { width: number }): Promise<void> => {
  // useIsMobile reads window.innerWidth when the provider mounts.
  Object.assign(window, { innerWidth: width });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SidebarProvider hoverMode={true}>
        <Sidebar collapsible="icon">
          <div>sidebar body</div>
        </Sidebar>
        <ApSidebarToggle />
      </SidebarProvider>,
    );
  });
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom does not implement matchMedia, which useIsMobile subscribes to.
  Object.assign(window, {
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

describe('ApSidebarToggle', () => {
  // #647: the toggle flipped the desktop `open` state, which nothing renders from on
  // mobile, so tapping it never opened the Sheet and its icon showed "close" while the
  // Sheet was closed.
  it('opens and closes the mobile sheet, with the icon following the sheet', async () => {
    await mount({ width: 390 });
    expect(mobileSheet()).toBeNull();
    expect(shownIcon()).toBe('open');

    await clickToggle();
    expect(mobileSheet()).not.toBeNull();
    expect(shownIcon()).toBe('close');

    await clickToggle();
    expect(mobileSheet()).toBeNull();
    expect(shownIcon()).toBe('open');
  });

  it('still collapses and expands the desktop sidebar', async () => {
    await mount({ width: 1440 });
    expect(desktopState()).toBe('expanded');
    expect(shownIcon()).toBe('close');

    await clickToggle();
    expect(desktopState()).toBe('collapsed');
    expect(shownIcon()).toBe('open');

    await clickToggle();
    expect(desktopState()).toBe('expanded');
    expect(shownIcon()).toBe('close');
    expect(mobileSheet()).toBeNull();
  });
});

function toggleButton(): HTMLButtonElement | null {
  return container?.querySelector('button') ?? null;
}

async function clickToggle(): Promise<void> {
  await act(async () => {
    toggleButton()?.click();
  });
}

function mobileSheet(): Element | null {
  return document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
}

function desktopState(): string | null {
  return (
    document
      .querySelector('.peer[data-slot="sidebar"]')
      ?.getAttribute('data-state') ?? null
  );
}

// The two icons share their frame and differ only in the chevron path.
function shownIcon(): 'open' | 'close' | 'unknown' {
  const html = toggleButton()?.innerHTML ?? '';
  if (html.includes('m14 9 3 3-3 3')) {
    return 'open';
  }
  if (html.includes('m16 15-3-3 3-3')) {
    return 'close';
  }
  return 'unknown';
}
