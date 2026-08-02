// @vitest-environment jsdom
import {
  AIProviderModel,
  AIProviderModelType,
  AIProviderName,
  AIProviderWithoutSensitiveData,
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
const PROVIDERS: AIProviderWithoutSensitiveData[] = [
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

const textModel = (id: string): AIProviderModel => ({
  id,
  name: id,
  type: AIProviderModelType.TEXT,
});

// Keyed by row id only. The picker never sends a provider *name* to this endpoint — it resolves
// the row first and asks by id — so a name-keyed entry here would be fixture that dresses the file
// as covering the server's name tiebreak while nothing ever reads it.
const MODELS_BY_ROW_ID: Record<string, AIProviderModel[]> = {
  [MISTRAL_ROW_ID]: [textModel('mistral-large')],
  // Two, so that "the picker reverted the model the user chose" is a thing this fixture can show.
  [FIRST_CUSTOM_ROW_ID]: [
    textModel('first-row-model'),
    textModel('first-row-model-mini'),
  ],
  [SECOND_CUSTOM_ROW_ID]: [textModel('second-row-model')],
};

const listModelsForProvider = vi.fn(async (rowId: string) => {
  return MODELS_BY_ROW_ID[rowId] ?? [];
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

// cmdk renders each item's `value` — the identity it filters and selects on — as `data-value`.
const itemValues = () =>
  [...document.querySelectorAll('[cmdk-item]')].map(
    (item) => item.getAttribute('data-value') ?? '',
  );

const checkedItems = () =>
  [...document.querySelectorAll('[cmdk-item] .opacity-100')].map(
    (mark) => mark.closest('[cmdk-item]')?.textContent ?? '',
  );

const unresolvedRefHints = () => [
  ...document.querySelectorAll('[data-testid="ai-provider-unresolved-ref"]'),
];

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

    // The collision itself, as cmdk sees it. `value` is the identity cmdk filters and selects on,
    // and it reaches the DOM as `data-value` — two rows named "Ollama" gave it one identity for
    // two entries. Keying on the row id is what separates them.
    expect([...itemValues()].sort()).toEqual(
      [MISTRAL_ROW_ID, FIRST_CUSTOM_ROW_ID, SECOND_CUSTOM_ROW_ID].sort(),
    );
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

    expect(checkedItems()).toEqual(['Ollamahttps://second.example.com/v1']);
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
    expect(itemTexts()).toEqual(['first-row-model', 'first-row-model-mini']);
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

  // Picking a model is the most common interaction here, and it is an emission like any other:
  // before #282 landed, an emission that omitted the row id erased the pin on every model pick.
  it('emits the pinned row id when the user picks a model, not just the model', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProviderId: FIRST_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange,
    });

    await openModelDropdown();
    await click(findItem('first-row-model-mini'));

    expect(onChange).toHaveBeenLastCalledWith({
      providerId: FIRST_CUSTOM_ROW_ID,
      provider: AIProviderName.CUSTOM,
      model: 'first-row-model-mini',
    });
  });

  // The catalogue effect exists only to replace a model the provider no longer serves. Without its
  // "the stored model is still in the catalogue" guard it also overwrites a model the operator just
  // chose, on the very next render, with whatever happens to be first.
  it('leaves a model the user picked alone instead of reverting it to the first in the catalogue', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProviderId: FIRST_CUSTOM_ROW_ID,
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange,
    });

    await openModelDropdown();
    await click(findItem('first-row-model-mini'));
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    const modelTriggerText = comboboxes()[1].textContent ?? '';
    expect(modelTriggerText).toContain('first-row-model-mini');
  });

  // The name path answers with the platform's *oldest* row of that type, which is only a claim a
  // provider with more than one row can test — `MISTRAL` has one, so it cannot see a reversed scan.
  it('resolves a name-only step to the oldest row of that type, not the newest', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProvider: AIProviderName.CUSTOM,
      defaultModel: 'first-row-model',
      onChange,
    });

    await openProviderDropdown();

    expect(checkedItems()).toEqual(['Ollamahttps://first.example.com/v1']);
    expect(listModelsForProvider).toHaveBeenCalledWith(FIRST_CUSTOM_ROW_ID);
    expect(listModelsForProvider).not.toHaveBeenCalledWith(
      SECOND_CUSTOM_ROW_ID,
    );
  });

  // The reachable form of the swap: `provider` is non-optional on a stored `aiProviderModel`, so a
  // deleted row leaves a ref whose *type* still matches a sibling. Merely opening the step must not
  // re-point it at that sibling — the server answers a dead id with ENTITY_NOT_FOUND, and a picker
  // that quietly substitutes turns that hard failure into prompts sent to another endpoint.
  it('leaves the picker unresolved when the stored row id no longer exists, and writes nothing', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProviderId: 'a-row-that-was-deleted',
      defaultProvider: AIProviderName.CUSTOM,
      // Absent from the surviving sibling's catalogue, which is what makes the catalogue effect
      // want to emit.
      defaultModel: 'second-row-model',
      onChange,
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(listModelsForProvider).not.toHaveBeenCalled();
    // Asserted by test id, not by copy: i18next is not initialised here, so `t()` answers ''.
    expect(unresolvedRefHints()).toHaveLength(1);

    await openProviderDropdown();

    expect(checkedItems()).toEqual([]);
  });

  // The other half of the same rule: a step stored before id-addressing carries only a name, and
  // that name must still resolve the way the server resolves it.
  it('still resolves a step that stores a provider name and no row id', async () => {
    const onChange = vi.fn();
    await mountSelector({
      defaultProvider: AIProviderName.MISTRAL,
      defaultModel: 'mistral-large',
      onChange,
    });

    await openProviderDropdown();

    expect(checkedItems()).toEqual(['Mistral AI']);
    expect(onChange).not.toHaveBeenCalled();
    expect(unresolvedRefHints()).toHaveLength(0);
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
