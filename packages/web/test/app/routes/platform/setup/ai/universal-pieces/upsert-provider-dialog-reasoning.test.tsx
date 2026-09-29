// @vitest-environment jsdom
import {
  AIProviderConfig,
  AIProviderName,
  CreateAIProviderRequest,
  UpdateAIProviderRequest,
} from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { UpsertAIProviderDialogContent } from '@/app/routes/platform/setup/ai/universal-pieces/upsert-provider-dialog';
import { Dialog } from '@/components/ui/dialog';

const { upsert, update } = vi.hoisted(() => ({
  upsert: vi.fn(async (_request: CreateAIProviderRequest) => undefined),
  update: vi.fn(
    async (_providerId: string, _request: UpdateAIProviderRequest) => undefined,
  ),
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

const openDialog = async ({
  provider,
  config,
}: {
  provider: AIProviderName;
  config?: AIProviderConfig;
}): Promise<void> => {
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
            target={
              config === undefined
                ? { type: 'create' }
                : { type: 'edit', providerId: 'row-1', config }
            }
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

// A React-controlled input ignores a plain `input.value = …`; see ldap-dialog.test.tsx.
const typeInto = async (id: string, value: string): Promise<void> => {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input#${id}`);
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!valueSetter) throw new Error('HTMLInputElement has no value setter');
  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const toggleReasoning = async (): Promise<void> => {
  const toggle = document.getElementById('chatReasoning');
  if (!toggle) throw new Error('the reasoning switch is not rendered');
  await act(async () => {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const submit = async (): Promise<void> => {
  const form = document.body.querySelector('form');
  if (!form) throw new Error('form not rendered');
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  // The resolver and the mutation settle on later ticks.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('provider dialog: reasoning in chat (#566)', () => {
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

  it.each([
    AIProviderName.ANTHROPIC,
    AIProviderName.BEDROCK,
    AIProviderName.OPENROUTER,
    AIProviderName.GOOGLE,
  ])('offers the switch, off, for %s', async (provider) => {
    await openDialog({ provider });

    const toggle = document.getElementById('chatReasoning');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById('chatReasoningBudget')).toBeNull();
  });

  it.each([
    AIProviderName.OPENAI,
    AIProviderName.AZURE,
    AIProviderName.CUSTOM,
    AIProviderName.CLOUDFLARE_GATEWAY,
    AIProviderName.MISTRAL,
  ])('does not offer it for %s', async (provider) => {
    await openDialog({ provider });

    expect(document.getElementById('chatReasoning')).toBeNull();
  });

  it('saves a row without the setting when the switch is never touched', async () => {
    await openDialog({ provider: AIProviderName.ANTHROPIC });
    await typeInto('apiKey', 'sk-ant');

    await submit();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].config).toEqual({});
  });

  it('saves the switch and the budget the admin typed', async () => {
    await openDialog({ provider: AIProviderName.ANTHROPIC });
    await typeInto('apiKey', 'sk-ant');
    await toggleReasoning();
    await typeInto('chatReasoningBudget', '12000');

    await submit();

    expect(upsert.mock.calls[0][0].config).toEqual({
      reasoning: { enabled: true, budgetTokens: 12_000 },
    });
  });

  it('seeds the budget with the default when the switch is first turned on', async () => {
    await openDialog({ provider: AIProviderName.GOOGLE });
    await toggleReasoning();

    const budget = document.getElementById('chatReasoningBudget');
    expect(budget instanceof HTMLInputElement ? budget.value : null).toBe(
      '8000',
    );
  });

  it.each([
    ['below the minimum', '512'],
    ['above the maximum', '50000'],
    ['empty', ''],
    ['a fraction', '2048.5'],
  ])(
    'refuses a budget %s with the translated range message',
    async (_label, text) => {
      await openDialog({ provider: AIProviderName.OPENROUTER });
      await typeInto('apiKey', 'sk-or');
      await toggleReasoning();
      await typeInto('chatReasoningBudget', text);

      await submit();

      expect(upsert).not.toHaveBeenCalled();
      // Read into a string first: jest-dom's matchers are not registered here (#557), and its lint
      // rule would otherwise rewrite this into `toHaveTextContent`.
      const rendered = document.body.textContent ?? '';
      expect(rendered).toContain('reasoningBudgetTokensOutOfRange');
    },
  );

  // With the switch off the budget input — and the only message that could name its error — is
  // unmounted, so an invalid budget left behind would make Save do nothing, silently. Before the
  // fix the switch wrote back a stale copy of the budget, which hid this case and lost a valid
  // budget instead (the next test); reading the current value exposes it, hence the reset.
  it.each([
    ['empty', ''],
    ['out-of-range', '500'],
  ])(
    'saves with the default budget when an %s budget is left behind by turning the switch off',
    async (_label, text) => {
      await openDialog({ provider: AIProviderName.ANTHROPIC });
      await typeInto('apiKey', 'sk-ant');
      await toggleReasoning();
      await typeInto('chatReasoningBudget', text);
      await toggleReasoning();

      await submit();

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0].config).toEqual({
        reasoning: { enabled: false, budgetTokens: 8_000 },
      });
    },
  );

  // The switch used to write back the budget it saw on its own last render, which the budget
  // input's keystrokes never refreshed — so the value just typed was replaced by the default.
  it('keeps the budget the admin typed when the switch then goes off', async () => {
    await openDialog({ provider: AIProviderName.ANTHROPIC });
    await typeInto('apiKey', 'sk-ant');
    await toggleReasoning();
    await typeInto('chatReasoningBudget', '12000');
    await toggleReasoning();

    await submit();

    expect(upsert.mock.calls[0]?.[0].config).toEqual({
      reasoning: { enabled: false, budgetTokens: 12_000 },
    });
  });

  it('keeps the budget when an edit turns the switch off', async () => {
    await openDialog({
      provider: AIProviderName.BEDROCK,
      config: {
        region: 'us-east-1',
        reasoning: { enabled: true, budgetTokens: 6_000 },
      },
    });
    expect(
      document.getElementById('chatReasoning')?.getAttribute('aria-checked'),
    ).toBe('true');

    await toggleReasoning();
    await submit();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1].config).toEqual({
      region: 'us-east-1',
      reasoning: { enabled: false, budgetTokens: 6_000 },
    });
  });
});
