import { describe, it, expect } from 'vitest';

import { aiProviderModelValue } from '@/app/builder/step-settings/agent-settings/ai-provider-model-value';

describe('aiProviderModelValue.applySelection', () => {
  it('keeps a pinned provider row when only the model changes', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'deepseek-chat',
          providerId: 'row-2',
        },
        selection: { provider: 'custom', model: 'deepseek-reasoner' },
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-reasoner',
      providerId: 'row-2',
    });
  });

  it('keeps a pinned provider row through the unprompted fallback emission', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'a-model-the-catalogue-no-longer-lists',
          providerId: 'row-2',
        },
        selection: { provider: 'custom', model: 'deepseek-chat' },
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-chat',
      providerId: 'row-2',
    });
  });

  it('keeps every key the picker does not know about, not just providerId', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'openai',
          model: 'gpt-4o',
          providerId: 'row-1',
          somethingAddedLater: { nested: true },
        },
        selection: { provider: 'openai', model: 'gpt-4o-mini' },
      }),
    ).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      providerId: 'row-1',
      somethingAddedLater: { nested: true },
    });
  });

  it('drops the pinned row when the provider itself changes', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'deepseek-chat',
          providerId: 'row-2',
        },
        selection: { provider: 'openai', model: undefined },
      }),
    ).toEqual({ provider: 'openai', model: undefined });
  });

  it('does not mutate the stored value', () => {
    const storedValue = {
      provider: 'custom',
      model: 'deepseek-chat',
      providerId: 'row-2',
    };
    aiProviderModelValue.applySelection({
      storedValue,
      selection: { provider: 'custom', model: 'deepseek-reasoner' },
    });
    expect(storedValue.model).toBe('deepseek-chat');
  });

  it('falls back to the selection when nothing usable is stored', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: undefined,
        selection: { provider: 'openai', model: 'gpt-4o' },
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });
});
