// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  FROM_QUERY_PARAM,
  useRedirectAfterLogin,
} from '@/lib/navigation-utils';
import { redirectUtils } from '@/lib/redirect-utils';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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

describe('useRedirectAfterLogin', () => {
  it('navigates to a same-origin `from` path', async () => {
    const landed = await redirectFrom('/runs?status=FAILED');
    expect(landed).toBe('/runs?status=FAILED');
  });

  it.each(['//example.com', '/\\example.com', 'https://example.com'])(
    'navigates to the default route when `from` would leave the origin: %j',
    async (from) => {
      const landed = await redirectFrom(from);
      expect(landed).toBe(redirectUtils.DEFAULT_REDIRECT_PATH);
    },
  );

  it('navigates to the default route when `from` is absent', async () => {
    const landed = await landingPathFor('/sign-in');
    expect(landed).toBe(redirectUtils.DEFAULT_REDIRECT_PATH);
  });
});

async function redirectFrom(from: string): Promise<string> {
  return landingPathFor(
    `/sign-in?${new URLSearchParams({ [FROM_QUERY_PARAM]: from }).toString()}`,
  );
}

async function landingPathFor(initialEntry: string): Promise<string> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/sign-in" element={<RedirectOnMount />} />
          <Route path="*" element={<CurrentLocation />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container.querySelector('[data-testid="location"]')?.textContent ?? '';
}

function RedirectOnMount() {
  const redirectAfterLogin = useRedirectAfterLogin();
  React.useEffect(() => {
    redirectAfterLogin();
  }, [redirectAfterLogin]);
  return null;
}

function CurrentLocation() {
  const location = useLocation();
  return (
    <span data-testid="location">{`${location.pathname}${location.search}`}</span>
  );
}
