// @vitest-environment jsdom
import { isValidElement, ReactNode } from 'react';
import { Navigate } from 'react-router';
import { describe, expect, it } from 'vitest';

import { projectRoutes } from '@/app/routes/project-routes';

// Project Releases has no server implementation in this repo (#856), so no
// route may render the page that talks to /v1/project-releases.
describe('project releases routes', () => {
  const releaseRoutes = projectRoutes.filter((route) =>
    /\/releases(\/|$)/.test(route.path),
  );

  it('registers both the scoped and the unscoped variant of each release route', () => {
    expect(releaseRoutes.map((route) => route.path).sort()).toEqual([
      '/projects/:projectId/releases',
      '/projects/:projectId/releases/:releaseId',
      '/releases',
      '/releases/:releaseId',
    ]);
  });

  it.each(releaseRoutes.map((route) => [route.path, route.element] as const))(
    '%s redirects to automations instead of rendering the releases page',
    (_path, element) => {
      const redirect = findNavigate(element);

      expect(redirect).toBeDefined();
      expect(redirect?.to).toBe('/automations');
    },
  );
});

function findNavigate(node: ReactNode): { to: unknown } | undefined {
  if (!isValidElement<{ children?: ReactNode; to?: unknown }>(node)) {
    return undefined;
  }
  if (node.type === Navigate) {
    return { to: node.props.to };
  }
  return findNavigate(node.props.children);
}
