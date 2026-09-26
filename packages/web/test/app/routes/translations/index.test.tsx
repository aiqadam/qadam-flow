// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TranslationsPage } from '@/app/routes/translations';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getProjectId: () => 'project1',
  },
}));

vi.mock('@/hooks/authorization-hooks', () => ({
  useAuthorization: () => ({ checkAccess: () => true }),
}));

vi.mock('@/features/projects', () => ({
  projectCollectionUtils: {
    useCurrentProject: () => ({ project: { defaultLocale: null } }),
  },
}));

vi.mock('@/features/translations/hooks/translations-hooks', () => ({
  translationsQueries: {
    useTranslations: () => ({
      data: { data: [], next: null, previous: null },
      isLoading: false,
      refetch: () => {},
    }),
    useListSearchParams: () => ({
      cursor: undefined,
      limit: 25,
      key: undefined,
      missing: false,
    }),
    useUsages: () => ({ data: undefined, isLoading: false }),
  },
  translationsMutations: {
    useBulkDeleteTranslations: () => ({ mutateAsync: async () => {} }),
    useUpsertBatch: () => ({ mutate: () => {}, isPending: false }),
    useImport: () => ({ mutate: () => {}, isPending: false }),
  },
}));

// `DataTable` itself is generic table plumbing unrelated to this bug — stubbed down to just
// rendering `toolbarButtons` so the test exercises the real `TranslationsPage` composition
// (where the bug actually lives) without pulling in tanstack-table internals.
vi.mock('@/components/custom/data-table', () => ({
  DataTable: (props: { toolbarButtons?: React.ReactNode[] }) => (
    <div>{props.toolbarButtons}</div>
  ),
  CURSOR_QUERY_PARAM: 'cursor',
  LIMIT_QUERY_PARAM: 'limit',
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
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
        <MemoryRouter>
          <TranslationsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
};

const findButtonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().includes(text),
  );

const click = async (element: Element): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
});

describe('TranslationsPage — Import button', () => {
  it("opens the import dialog when clicked (regression: PermissionNeededTooltip swallowed DialogTrigger's onClick when nested inside the dialog)", async () => {
    await mount();

    expect(document.body?.textContent).not.toContain('Import translations');

    await click(findButtonByText('Import')!);

    expect(document.body?.textContent).toContain('Import translations');
  });
});
