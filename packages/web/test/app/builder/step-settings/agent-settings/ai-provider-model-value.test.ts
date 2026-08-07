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
        userGesture: true,
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
        userGesture: false,
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
        userGesture: true,
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
        userGesture: true,
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
        userGesture: true,
      }),
    ).toEqual({ providerId: 'row-3', provider: 'custom', model: undefined });
  });

  // `rowChanged` can never be true here — it requires both sides to already carry an id, and a
  // name-only stored value never does — so this is the one case the value diff alone cannot
  // decide, and `userGesture` is what has to. This is the picker pinning a step that only ever
  // stored a name to the row that name already resolved to (`handleProviderChange` /
  // `handleModelChange`), a deliberate act the same as PR #285 intended. Reading it as a row
  // change would also drop extras on a step nothing actually moved.
  it('pins a name-only step when the user deliberately picks a row', () => {
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
        userGesture: true,
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-chat',
      providerId: 'row-1',
      storedBeforeIdAddressing: true,
    });
  });

  // The other half of the same pair, and the case #299 found untested: the model picker's
  // reconcile effect fires when a step opens with a name-only ref whose model the catalogue no
  // longer serves, and it re-resolves both the row and a fallback model with no user gesture at
  // all. Merging its `providerId` would convert a self-healing name ref into a hard pin — silently,
  // and only visible later if that row is ever deleted.
  it('re-resolves a stale model on a name-only ref without pinning a providerId', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: {
          provider: 'custom',
          model: 'a-model-the-catalogue-no-longer-lists',
        },
        selection: {
          providerId: 'row-1',
          provider: 'custom',
          model: 'deepseek-chat',
        },
        userGesture: false,
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-chat',
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
      userGesture: true,
    });
    expect(storedValue.model).toBe('deepseek-chat');
  });

  it('falls back to the selection when nothing usable is stored', () => {
    expect(
      aiProviderModelValue.applySelection({
        storedValue: undefined,
        selection: { provider: 'openai', model: 'gpt-4o' },
        userGesture: true,
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
        userGesture: true,
      }),
    ).toEqual({
      provider: 'custom',
      model: 'deepseek-reasoner',
      providerId: 'row-2',
    });
  });
});
