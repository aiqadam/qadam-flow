import { omit } from '@aiqadam/shared';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * The stored `aiProviderModel` can carry keys the picker does not emit, and handing the picker's
 * emission straight to `field.onChange` replaces the stored object and drops them. `providerId` —
 * the key that pins a step to one specific AI provider row rather than the oldest row of that
 * type — is no longer always one of them: the picker now chooses the row deliberately and emits
 * its id, so a selection that actually moved to a different row or provider carries it like any
 * other selected key. It still exists for the keys nothing has added yet, and for whatever a later
 * part stores alongside the model.
 *
 * Keys the picker does not know about are kept, except when the *row* changes: they were chosen
 * against the previous row and would otherwise ride onto the new one. Two ways a row changes, and
 * the first cannot see the second:
 *
 * - the provider type changed — a different kind of endpoint entirely;
 * - the type stayed the same but the id did. A platform may hold several custom
 *   (OpenAI-compatible) rows, so moving from one to another leaves `provider` at `custom`. Only
 *   the id says these are different endpoints.
 *
 * Both comparisons require the selection to actually carry the key. A selection that omits one is
 * not evidence that it became `undefined`, and reading it that way would drop the stored value
 * this helper exists to protect.
 *
 * Neither of those two signals fires when the stored value has no id at all — a name-only ref
 * always reads as "same row, same provider", because there is nothing to compare the incoming id
 * against. That call still needs to merge a re-resolved model or other keys, but it must not merge
 * a `providerId` in the process: no migration writes an id into a step, and nothing that hasn't
 * moved should either. Only a call that did move (a genuine row or provider change) is trusted to
 * carry `providerId` forward.
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
  // A stored value with no id was resolved by name, and the picker pins it to the very row that
  // name already resolved to — so an id appearing where there was none is not a move.
  const rowChanged =
    storedValue.providerId !== undefined &&
    selection.providerId !== undefined &&
    storedValue.providerId !== selection.providerId;
  const providerChanged =
    selection.provider !== undefined &&
    storedValue.provider !== selection.provider;
  if (rowChanged || providerChanged) {
    return { ...selection };
  }
  // Neither the row nor the provider actually changed, so this call did not decide to pin
  // anything — it is a reconcile (e.g. re-resolving a stale model on open), not a user gesture.
  // A stored value with no id must stay self-healing by name; merging in whatever `providerId`
  // the reconcile happened to resolve would silently convert it into a hard pin.
  if (storedValue.providerId === undefined) {
    return { ...storedValue, ...omit(selection, ['providerId']) };
  }
  return { ...storedValue, ...selection };
};

export const aiProviderModelValue = { applySelection };

export type AIProviderModelSelection = {
  providerId?: string;
  provider?: string;
  model?: string;
};
