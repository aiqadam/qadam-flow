const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * The model picker only knows about `provider` and `model`, but the stored
 * `aiProviderModel` can carry more than that — `providerId`, which pins a step
 * to one specific AI provider row rather than the oldest row of that type.
 * Handing the picker's emission straight to `field.onChange` replaces the
 * stored object and drops those keys, so a pinned step silently loses its pin
 * and later runs against a different row.
 *
 * Keys the picker does not know about are kept, except when the provider
 * itself changes: they were chosen against the previous provider, and a row id
 * belonging to another provider outranks the provider name at resolution time,
 * which would run the step against a provider the builder is no longer showing.
 */
const applySelection = ({
  storedValue,
  selection,
}: {
  storedValue: unknown;
  selection: AIProviderModelSelection;
}): AIProviderModelSelection & Record<string, unknown> => {
  if (!isPlainObject(storedValue)) {
    return { ...selection };
  }
  // Only a selection that names a provider can tell us the provider changed. Every emission site
  // sends one today, but a future one that sends only a model must not be read as "the provider
  // became undefined" — that would drop the stored provider along with the extras.
  if (
    selection.provider !== undefined &&
    storedValue.provider !== selection.provider
  ) {
    return { ...selection };
  }
  return { ...storedValue, ...selection };
};

export const aiProviderModelValue = { applySelection };

export type AIProviderModelSelection = {
  provider?: string;
  model?: string;
};
