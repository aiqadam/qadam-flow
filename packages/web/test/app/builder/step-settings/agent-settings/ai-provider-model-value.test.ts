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

  // The provider-name comparison below cannot see this one: a platform may hold several custom
  // rows, so moving from custom row A to custom row B is a provider change that leaves
  // `provider` at 'custom'. An extra chosen against row A would otherwise ride onto row B.
  it('drops extras when the row changes but the provider type does not', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'deepseek-chat',
          providerId: 'row-2',
          chosenAgainstRow2: true,
        },
        selection: {
          providerId: 'row-3',
          provider: 'custom',
          model: undefined,
        },
      }),
    ).toEqual({ providerId: 'row-3', provider: 'custom', model: undefined });
  });

  // The picker pins a step that only ever stored a name to the row that name already resolved to.
  // Reading that as a row change would drop extras on a step nothing actually moved.
  it('does not read a newly added row id as a row change', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'deepseek-chat',
          storedBeforeIdAddressing: true,
        },
        selection: {
          providerId: 'row-1',
          provider: 'custom',
          model: 'deepseek-chat',
        },
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-chat',
      providerId: 'row-1',
      storedBeforeIdAddressing: true,
    });
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

  // Every emission site names a provider today, so this is a guard against a future one that does
  // not. Reading an absent provider as a change would drop the stored provider along with the pin,
  // which is a worse outcome than the bug this helper exists to prevent.
  it('treats a selection with no provider as a model-only change, not a provider change', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'deepseek-chat',
          providerId: 'row-2',
        },
        selection: { model: 'deepseek-reasoner' },
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-reasoner',
      providerId: 'row-2',
    });
  });
});
