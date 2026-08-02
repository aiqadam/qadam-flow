// @vitest-environment jsdom
import {
  AIProviderModel,
  AIProviderModelType,
  AIProviderName,
} from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AIModelSelector } from '@/features/agents/ai-model';

const FIRST_CUSTOM_ROW_ID = 'kZqvV1x9Lm3aTbCd5EfGh';
const SECOND_CUSTOM_ROW_ID = 'wNpRs7Yu2Ij4KlMn6OpQr';
const MISTRAL_ROW_ID = 'aBcDeFgHiJkLmNoPqRsTu';

const openAICompatibleConfig = (baseUrl: string) => ({
  apiKeyHeader: 'Authorization',
  baseUrl,
  models: [],
});

// Two custom rows deliberately share a display name: nothing enforces uniqueness on it, so the
// picker cannot use it to tell them apart.
const PROVIDERS = [
  {
    id: FIRST_CUSTOM_ROW_ID,
    name: 'Ollama',
    provider: AIProviderName.CUSTOM,
    config: openAICompatibleConfig('https://first.example.com/v1'),
    enabledForChat: false,
  },
  {
    id: SECOND_CUSTOM_ROW_ID,
    name: 'Ollama',
    provider: AIProviderName.CUSTOM,
    config: openAICompatibleConfig('https://second.example.com/v1'),
    enabledForChat: false,
  },
  // Deliberately last, so "fell back to the first row" and "resolved by provider name" are
  // different answers rather than the same one.
  {
    id: MISTRAL_ROW_ID,
    name: 'Mistral AI',
    provider: AIProviderName.MISTRAL,
    config: {},
    enabledForChat: false,
  },
];

const MODELS_BY_REF: Record<string, AIProviderModel[]> = {
  [MISTRAL_ROW_ID]: [
    {
      id: 'mistral-large',
      name: 'mistral-large',
      type: AIProviderModelType.TEXT,
    },
  ],
  [FIRST_CUSTOM_ROW_ID]: [
    {
      id: 'first-row-model',
      name: 'first-row-model',
      type: AIProviderModelType.TEXT,
    },
  ],
  [SECOND_CUSTOM_ROW_ID]: [
    {
      id: 'second-row-model',
      name: 'second-row-model',
      type: AIProviderModelType.TEXT,
    },
  ],
  // What the server answers for a name-keyed ref: the platform's oldest row of that type
  // (`findProviderOrThrow`'s `created ASC, id ASC` tiebreak).
  [AIProviderName.CUSTOM]: [
    {
      id: 'first-row-model',
      name: 'first-row-model',
      type: AIProviderModelType.TEXT,
    },
  ],
  [AIProviderName.MISTRAL]: [
    {
      id: 'mistral-large',
      name: 'mistral-large',
      type: AIProviderModelType.TEXT,
    },
  ],
};

const listModelsForProvider = vi.fn(async (ref: string) => {
  return MODELS_BY_REF[ref] ?? [];
});

vi.mock('@/features/platform-admin/api/ai-provider-api', () => ({
  aiProviderApi: {
    list: async () => PROVIDERS,
    listModelsForProvider: (ref: string) => listModelsForProvider(ref),
  },
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mountSelector = async ({
  defaultProviderId,
  defaultProvider,
  defaultModel,
  onChange,
}: {
  defaultProviderId?: string;
  defaultProvider?: AIProviderName;
  defaultModel?: string;
  onChange: (value: Partial<AgentProviderModelSelection>) => void;
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AIModelSelector
          defaultProviderId={defaultProviderId}
          defaultProvider={defaultProvider}
          defaultModel={defaultModel}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
};

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

const comboboxes = () => [
  ...document.querySelectorAll('button[role="combobox"]'),
];

const openProviderDropdown = async () => {
  await click(comboboxes()[0]);
};

const openModelDropdown = async () => {
  await click(comboboxes()[1]);
};

const itemTexts = () =>
  [...document.querySelectorAll('[cmdk-item]')].map(
    (item) => item.textContent ?? '',
  );

const findItem = (matcher: string) => {
  const item = [...document.querySelectorAll('[cmdk-item]')].find((candidate) =>
    (candidate.textContent ?? '').includes(matcher),
  );
  if (!item) {
    throw new Error(
      `no dropdown entry matched "${matcher}", entries were: ${JSON.stringify(
        itemTexts(),
      )}`,
    );
  }
  return item;
};

const typeInSearchBox = async (search: string) => {
  const input = document.querySelector('input[data-slot="command-input"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('the dropdown has no search box');
  }
  // cmdk controls the input from its own state, so React ignores a plain `input.value = …`.
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!valueSetter) {
    throw new Error('HTMLInputElement has no value setter');
  }
  await act(async () => {
    valueSetter.call(input, search);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  // Radix portals its popover content outside the container, so an unmount alone can leave a
  // detached trigger behind — and every lookup here reads `document`.
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
  listModelsForProvider.mockClear();
});

describe('AIModelSelector, against a platform holding two custom provider rows', () => {
  it('lists every provider row, telling same-named custom rows apart by base url', async () => {
    await mountSelector({
      defaultProviderId: FIRST_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange: vi.fn(),
    });

    await openProviderDropdown();

    const entries = itemTexts();
    expect(entries).toHaveLength(3);
    expect(entries.filter((entry) => entry.includes('Ollama'))).toHaveLength(2);
    expect(entries).toContain('Ollamahttps://first.example.com/v1');
    expect(entries).toContain('Ollamahttps://second.example.com/v1');
  });

  it('still searches by display name and by base url, though entries are keyed by row id', async () => {
    await mountSelector({
      defaultProviderId: FIRST_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange: vi.fn(),
    });

    await openProviderDropdown();

    await typeInSearchBox('Mistral');
    expect(itemTexts()).toEqual(['Mistral AI']);

    await typeInSearchBox('second.example.com');
    expect(itemTexts()).toEqual(['Ollamahttps://second.example.com/v1']);
  });

  it('checks exactly one entry — the row the step is pinned to', async () => {
    await mountSelector({
      defaultProviderId: SECOND_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'second-row-model',
      onChange: vi.fn(),
    });

    await openProviderDropdown();

    const checked = [
      ...document.querySelectorAll('[cmdk-item] .opacity-100'),
    ].map((mark) => mark.closest('[cmdk-item]')?.textContent ?? '');
    expect(checked).toEqual(['Ollamahttps://second.example.com/v1']);
  });

  it('emits the picked row id when the second custom row is selected', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProviderId: FIRST_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange,
    });

    await openProviderDropdown();
    await click(findItem('https://second.example.com/v1'));

    expect(onChange).toHaveBeenCalledWith({
      providerId: SECOND_CUSTOM_ROW_ID,
      provider: AIProviderName.CUSTOM,
      model: undefined,
    });
  });

  it('shows the picked row its own model catalogue, not the oldest row of the same type', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProviderId: FIRST_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange,
    });

    await openModelDropdown();
    expect(itemTexts()).toEqual(['first-row-model']);
    await click(comboboxes()[1]);

    await openProviderDropdown();
    await click(findItem('https://second.example.com/v1'));
    await openModelDropdown();

    expect(itemTexts()).toEqual(['second-row-model']);
    expect(listModelsForProvider).toHaveBeenCalledWith(SECOND_CUSTOM_ROW_ID);
    expect(onChange).toHaveBeenLastCalledWith({
      providerId: SECOND_CUSTOM_ROW_ID,
      provider: AIProviderName.CUSTOM,
      model: 'second-row-model',
    });
  });

  it('resolves a stored row id that no longer exists by provider name, without rewriting the step to another type', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProviderId: 'a-row-that-was-deleted',
      defaultProvider: AIProviderName.MISTRAL,
      defaultModel: 'mistral-large',
      onChange,
    });

    await openProviderDropdown();

    const checked = [
      ...document.querySelectorAll('[cmdk-item] .opacity-100'),
    ].map((mark) => mark.closest('[cmdk-item]')?.textContent ?? '');
    expect(checked).toEqual(['Mistral AI']);
  });

  it('pins a step that stores no provider reference at all to the first row, id included', async () => {
    const onChange = vi.fn();
    await mountSelector({ onChange });

    expect(onChange).toHaveBeenLastCalledWith({
      providerId: FIRST_CUSTOM_ROW_ID,
      provider: AIProviderName.CUSTOM,
      model: 'first-row-model',
    });
  });
});

type AgentProviderModelSelection = {
  providerId?: string;
  provider?: string;
  model?: string;
};
