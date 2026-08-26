// @vitest-environment jsdom
import { UserWithBadges } from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act, Suspense } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useApErrorDialogStore } from '@/components/custom/ap-error-dialog/ap-error-dialog-store';
import { userHooks } from '@/hooks/user-hooks';

const harness = vi.hoisted(() => {
  const state: {
    getCurrentUser: () => Promise<UserWithBadges>;
    isJwtExpired: boolean;
    isOnboarding: boolean;
  } = {
    getCurrentUser: () => Promise.reject(new Error('not configured')),
    isJwtExpired: false,
    isOnboarding: false,
  };
  return { state };
});

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getCurrentUserId: () => 'user-1',
    getToken: () => 'token',
    isJwtExpired: () => harness.state.isJwtExpired,
    isOnboarding: () => harness.state.isOnboarding,
  },
}));

vi.mock('@/api/user-api', () => ({
  userApi: {
    getCurrentUser: () => harness.state.getCurrentUser(),
  },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let result: { data: UserWithBadges | null } | undefined;

const Harness = () => {
  result = userHooks.useCurrentUser();
  return null;
};

const mount = async (): Promise<void> => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <Harness />
        </Suspense>
      </QueryClientProvider>,
    );
    // Let the suspended query resolve/reject and the resulting re-render flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
};

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
  result = undefined;
  harness.state.isJwtExpired = false;
  harness.state.isOnboarding = false;
  useApErrorDialogStore.setState({ params: null });
});

describe('userHooks.useCurrentUser', () => {
  it('reads the self-scoped record and returns it without opening the error dialog', async () => {
    const user = { id: 'user-1', email: 'a@b.com' } as UserWithBadges;
    harness.state.getCurrentUser = () => Promise.resolve(user);

    await mount();

    expect(result?.data).toEqual(user);
    expect(useApErrorDialogStore.getState().params).toBeNull();
  });

  // This is the defect #349 reopens on: a 403 (or any other failure) used to vanish into
  // `console.error` and the sidebar profile block — including Sign Out — just disappeared with
  // no visible explanation. Revert the dialog call in the `catch` and this goes red while `data`
  // still (wrongly) looks fine.
  it('opens the error dialog and returns null when the request fails for a reason other than an expired token', async () => {
    harness.state.isJwtExpired = false;
    harness.state.getCurrentUser = () =>
      Promise.reject(new Error('403 not an admin'));

    await mount();

    expect(result?.data).toBeNull();
    expect(useApErrorDialogStore.getState().params).not.toBeNull();
  });

  // The embed case this hook was written to protect: an expired JWT during embedding must stay
  // silent (no dialog, no request), or the original global-error redirect this guard exists to
  // avoid comes back. Pin it so the visible-error fix above cannot regress it.
  it('does not call the API or open the error dialog when the JWT is expired', async () => {
    harness.state.isJwtExpired = true;
    const getCurrentUser = vi.fn(() => Promise.resolve({} as UserWithBadges));
    harness.state.getCurrentUser = getCurrentUser;

    await mount();

    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(result?.data).toBeNull();
    expect(useApErrorDialogStore.getState().params).toBeNull();
  });

  // #357's review finding: an ONBOARDING principal (issued right after sign-up, before a
  // platform exists) has no `platform` field, so GetCurrentUserRequest — which requires
  // USER/SERVICE — always 403s for it. Without this guard, /create-platform hits that 403 on
  // every render and react-query retries with backoff, stalling the page for ~15-20s with no
  // visible error (the catch above swallows it silently by design for the embed case, but this
  // isn't that case — it's a route where the request should never have been made at all).
  it('does not call the API or open the error dialog for an ONBOARDING principal', async () => {
    harness.state.isOnboarding = true;
    const getCurrentUser = vi.fn(() => Promise.resolve({} as UserWithBadges));
    harness.state.getCurrentUser = getCurrentUser;

    await mount();

    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(result?.data).toBeNull();
    expect(useApErrorDialogStore.getState().params).toBeNull();
  });
});
