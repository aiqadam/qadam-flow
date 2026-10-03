// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedirectPage } from '@/app/routes/redirect';
import {
  FROM_QUERY_PARAM,
  LOGIN_QUERY_PARAM,
  PROVIDER_NAME_QUERY_PARAM,
  STATE_QUERY_PARAM,
} from '@/lib/navigation-utils';
import { redirectUtils } from '@/lib/redirect-utils';

vi.mock('@/api/authentication-api', () => ({
  authenticationApi: {
    claimThirdPartyRequest: () => Promise.resolve({ projectId: 'project-1' }),
  },
}));

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    saveResponse: () => undefined,
  },
}));

vi.mock('@/components/custom/loading-screen', () => ({
  LoadingScreen: () => null,
}));

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

describe('RedirectPage third-party sign-in', () => {
  it('navigates to a same-origin `from` carried in state', async () => {
    const landed = await landingPathForStateFrom('/runs?status=FAILED');
    expect(landed).toBe('/runs?status=FAILED');
  });

  it.each([
    42,
    null,
    { path: '/runs' },
    '//example.com',
    'https://example.com',
  ])(
    'navigates to the default route for a `from` that is not a same-origin path: %j',
    async (from) => {
      const landed = await landingPathForStateFrom(from);
      expect(landed).toBe(redirectUtils.DEFAULT_REDIRECT_PATH);
    },
  );
});

async function landingPathForStateFrom(from: unknown): Promise<string> {
  const state = JSON.stringify({
    [PROVIDER_NAME_QUERY_PARAM]: 'google',
    [FROM_QUERY_PARAM]: from,
    [LOGIN_QUERY_PARAM]: 'true',
  });
  const search = new URLSearchParams({
    code: 'auth-code',
    [STATE_QUERY_PARAM]: state,
  }).toString();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[`/redirect?${search}`]}>
        <Routes>
          <Route path="/redirect" element={<RedirectPage />} />
          <Route path="*" element={<CurrentLocation />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container.querySelector('[data-testid="location"]')?.textContent ?? '';
}

function CurrentLocation() {
  const location = useLocation();
  return (
    <span data-testid="location">{`${location.pathname}${location.search}`}</span>
  );
}
