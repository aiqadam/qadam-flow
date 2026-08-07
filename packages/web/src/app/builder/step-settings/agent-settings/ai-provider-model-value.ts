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
 * Neither of those two signals can fire when the stored value has no id at all: `rowChanged` is
 * defined to require both sides to already carry one, so a name-only ref always reads as "same
 * row, same provider" no matter what the selection carries — there is nothing to compare the
 * incoming id against. That is exactly the shape of two different calls: the picker's `onChange`
 * from a deliberate row pick (`handleProviderChange` / `handleModelChange` in the model selector),
 * which must still be allowed to pin a name-only ref, and the picker's reconcile effect
 * re-resolving a stale model with no user gesture at all, which must not. `userGesture` is the
 * caller's own record of which one this is — the value diff alone cannot tell them apart.
 */
const applySelection = ({
  storedValue,
  selection,
  userGesture,
}: {
  storedValue: unknown;
  selection: AIProviderModelSelection;
  userGesture: boolean;
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
  // Neither signal can fire for a name-only ref (see above), so a reconcile call and a deliberate
  // pick of the same row look identical here. Only the caller-supplied `userGesture` tells them
  // apart: a reconcile must stay self-healing by name, but a deliberate pick is trusted to carry
  // `providerId` forward even from a name-only ref, same as PR #285 intended.
  if (!userGesture && storedValue.providerId === undefined) {
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
