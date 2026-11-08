// @vitest-environment jsdom
import { AIProviderName, CreateAIProviderRequest } from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { UpsertAIProviderDialogContent } from '@/app/routes/platform/setup/ai/universal-pieces/upsert-provider-dialog';
import { Dialog } from '@/components/ui/dialog';

const { upsert, update } = vi.hoisted(() => ({
  upsert: vi.fn(async (_request: CreateAIProviderRequest) => undefined),
  update: vi.fn(async (_providerId: string, _request: unknown) => undefined),
}));

// i18next is not initialised in this harness; the key is what gets rendered.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

vi.mock('@/features/platform-admin', () => ({
  aiProviderApi: { upsert, update },
  hasAnyAuthFieldFilled: (auth: Record<string, unknown> | undefined) =>
    Object.values(auth ?? {}).some(
      (value) => typeof value === 'string' && value.length > 0,
    ),
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const openDialog = async (provider: AIProviderName): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Dialog open>
          <UpsertAIProviderDialogContent
            provider={provider}
            target={{ type: 'create' }}
            defaultDisplayName={provider}
            onSave={() => undefined}
            setOpen={() => undefined}
          >
            <button type="button">open</button>
          </UpsertAIProviderDialogContent>
        </Dialog>
      </QueryClientProvider>,
    );
  });
};

describe('provider dialog: API-key masking (#273)', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    // The dialog's ScrollArea measures itself through ResizeObserver, which jsdom does not have.
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.assign(globalThis, { ResizeObserver: NoopResizeObserver });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
    document.body.innerHTML = '';
    upsert.mockClear();
    update.mockClear();
  });

  it('masks the API key by default, and reveals it on toggle', async () => {
    await openDialog(AIProviderName.ANTHROPIC);

    const input = document.getElementById('apiKey');
    if (!(input instanceof HTMLInputElement)) throw new Error('no input#apiKey');
    expect(input.type).toBe('password');

    const toggle = document.querySelector('button[aria-label="Show value"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('no reveal toggle');
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(input.type).toBe('text');
    expect(
      document.querySelector('button[aria-label="Hide value"]'),
    ).not.toBeNull();
  });
});
