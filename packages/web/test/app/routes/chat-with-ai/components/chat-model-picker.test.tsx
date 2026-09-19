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

import { ChatModelPicker } from '@/app/routes/chat-with-ai/components/chat-model-picker';

const CHAT_PROVIDER_ID = 'chatProviderRow1';
const OTHER_PROVIDER_ID = 'otherProviderRow2';

const textModel = (id: string): AIProviderModel => ({
  id,
  name: id,
  type: AIProviderModelType.TEXT,
});

let providers: AIProviderWithoutSensitiveData[] = [];
let modelsByRowId: Record<string, AIProviderModel[]> = {};

const listModelsForProvider = vi.fn(async (rowId: string) => {
  return modelsByRowId[rowId] ?? [];
});

vi.mock('@/features/platform-admin/api/ai-provider-api', () => ({
  aiProviderApi: {
    list: async () => providers,
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

const mountPicker = async ({
  modelName = null,
  onModelChange = vi.fn(),
  disabled = false,
}: {
  modelName?: string | null;
  onModelChange?: (modelName: string) => void;
  disabled?: boolean;
} = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ChatModelPicker
          modelName={modelName}
          onModelChange={onModelChange}
          disabled={disabled}
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

const combobox = () => document.querySelector('button[role="combobox"]');

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
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
  providers = [];
  modelsByRowId = {};
  listModelsForProvider.mockClear();
});

describe('ChatModelPicker', () => {
  it('renders nothing when the platform has no chat-enabled provider', async () => {
    providers = [
      {
        id: OTHER_PROVIDER_ID,
        name: 'Mistral AI',
        provider: AIProviderName.MISTRAL,
        config: {},
        enabledForChat: false,
      },
    ];
    modelsByRowId = { [OTHER_PROVIDER_ID]: [textModel('mistral-large')] };

    await mountPicker();

    expect(container?.innerHTML).toBe('');
  });

  it('renders nothing when the chat-enabled provider has zero text models', async () => {
    providers = [
      {
        id: CHAT_PROVIDER_ID,
        name: 'Mistral AI',
        provider: AIProviderName.MISTRAL,
        config: {},
        enabledForChat: true,
      },
    ];
    modelsByRowId = { [CHAT_PROVIDER_ID]: [] };

    await mountPicker();

    expect(container?.innerHTML).toBe('');
  });

  it('shows "Auto" until a model is explicitly picked, then calls onModelChange with the chosen id', async () => {
    providers = [
      {
        id: CHAT_PROVIDER_ID,
        name: 'Mistral AI',
        provider: AIProviderName.MISTRAL,
        config: {},
        enabledForChat: true,
      },
    ];
    modelsByRowId = {
      [CHAT_PROVIDER_ID]: [
        textModel('mistral-large'),
        textModel('mistral-small'),
      ],
    };

    const onModelChange = vi.fn();
    await mountPicker({ modelName: null, onModelChange });

    const trigger = combobox();
    expect(trigger).not.toBeNull();
    // i18next is not initialised in this harness, so `t('Auto')` answers '' — asserted by absence
    // of any real model name instead of by the placeholder's copy (same rationale as
    // ai-model-selector.test.tsx's `unresolvedRefHints`).
    expect(trigger?.textContent).not.toContain('mistral-large');
    expect(trigger?.textContent).not.toContain('mistral-small');

    await click(trigger!);
    expect(itemTexts()).toEqual(['mistral-large', 'mistral-small']);

    await click(findItem('mistral-small'));

    expect(onModelChange).toHaveBeenCalledWith('mistral-small');
  });

  it('shows the resolved model name when the conversation already carries one', async () => {
    providers = [
      {
        id: CHAT_PROVIDER_ID,
        name: 'Mistral AI',
        provider: AIProviderName.MISTRAL,
        config: {},
        enabledForChat: true,
      },
    ];
    modelsByRowId = {
      [CHAT_PROVIDER_ID]: [
        textModel('mistral-large'),
        textModel('mistral-small'),
      ],
    };

    await mountPicker({ modelName: 'mistral-small' });

    expect(combobox()?.textContent).toContain('mistral-small');
  });
});
