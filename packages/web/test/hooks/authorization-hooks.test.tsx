// @vitest-environment jsdom
import { DefaultProjectRole, Permission, ProjectMemberRoleResponse } from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { useAuthorization } from '@/hooks/authorization-hooks';

const harness = vi.hoisted(() => {
  const state: { resolvers: ((response: ProjectMemberRoleResponse) => void)[] } = {
    resolvers: [],
  };
  return { state };
});

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getProjectId: () => 'project-1',
  },
}));

vi.mock('@/api/project-member-api', () => ({
  projectMemberApi: {
    getMyRole: () =>
      new Promise<ProjectMemberRoleResponse>((resolve) => {
        harness.state.resolvers.push(resolve);
      }),
  },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let authz: ReturnType<typeof useAuthorization> | undefined;

const Harness = () => {
  authz = useAuthorization();
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
        <Harness />
      </QueryClientProvider>,
    );
  });
};

// Resolves the in-flight `getMyRole` request and lets the resulting state update flush, mirroring
// the point where the project-role query has actually returned.
const resolveRoleAs = async (role: DefaultProjectRole): Promise<void> => {
  const resolve = harness.state.resolvers.pop();
  await act(async () => {
    resolve?.({ role });
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
  authz = undefined;
  harness.state.resolvers = [];
});

describe('useAuthorization', () => {
  it('defaults every permission to granted while the project role is still loading', async () => {
    await mount();

    // Nothing has resolved yet — this is the render the ticket warns about: a route guard or a
    // gated control evaluating `checkAccess` before the role is known must not read as denied,
    // or every route with a RoutePermissionGuard would bounce a legitimate user to /404 for one
    // frame on every load.
    expect(authz?.isFetchingProjectRole).toBe(true);
    expect(authz?.checkAccess(Permission.WRITE_INVITATION)).toBe(true);
    expect(authz?.checkAccess(Permission.WRITE_ALERT)).toBe(true);
  });

  it('hides VIEWER-gated controls once the role resolves to Viewer', async () => {
    await mount();
    await resolveRoleAs(DefaultProjectRole.VIEWER);

    expect(authz?.isFetchingProjectRole).toBe(false);
    // The invite form and the failure-alert toggles from #88/#92 are gated on exactly these.
    // A Viewer has neither WRITE_ALERT nor READ_ALERT (see `rolePermissions` in
    // access-control-list.ts), so `canManageAlerts` in ProjectMembersTab is false either way.
    expect(authz?.checkAccess(Permission.WRITE_INVITATION)).toBe(false);
    expect(authz?.checkAccess(Permission.WRITE_ALERT)).toBe(false);
    expect(authz?.checkAccess(Permission.READ_ALERT)).toBe(false);
    // Viewers keep read access — this must not become a blanket deny.
    expect(authz?.checkAccess(Permission.READ_FLOW)).toBe(true);
    expect(authz?.checkAccess(Permission.READ_PROJECT_MEMBER)).toBe(true);
  });

  it('keeps VIEWER-gated controls visible to an Admin once the role resolves', async () => {
    await mount();
    await resolveRoleAs(DefaultProjectRole.ADMIN);

    expect(authz?.checkAccess(Permission.WRITE_INVITATION)).toBe(true);
    expect(authz?.checkAccess(Permission.WRITE_ALERT)).toBe(true);
    expect(authz?.checkAccess(Permission.READ_ALERT)).toBe(true);
  });

  it('retains full access for the owner of a personal project', async () => {
    // `project-member.service.ts#getMyRole` resolves a personal-project owner to
    // `DefaultProjectRole.ADMIN` server-side (the owner never has a `project_member` row to read a
    // role from), so from this hook's perspective an owner is indistinguishable from an Admin —
    // this pins that contract on the client side rather than assuming it holds.
    await mount();
    await resolveRoleAs(DefaultProjectRole.ADMIN);

    expect(authz?.checkAccess(Permission.WRITE_PROJECT)).toBe(true);
    expect(authz?.checkAccess(Permission.WRITE_INVITATION)).toBe(true);
    expect(authz?.checkAccess(Permission.WRITE_FLOW)).toBe(true);
  });
});
