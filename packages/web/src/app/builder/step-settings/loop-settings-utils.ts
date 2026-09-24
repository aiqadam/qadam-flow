import { isNil } from '@aiqadam/shared';

// A loop setting is saved as the user types, and the API rejects a value outside the shared
// schema's bounds with a 400 that halts every later save in the session (#387). Only a value inside
// the bounds is ever committed; anything else stays in the input as text.
function parseBoundedNumber({
  text,
  min,
  max,
  integer,
  exclusiveMin,
}: ParseBoundedNumberParams): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    return undefined;
  }
  const aboveMin = exclusiveMin ? value > min : value >= min;
  return aboveMin && value <= max ? value : undefined;
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

export const loopSettingsUtils = {
  parseBoundedNumber,
  isBlank,
  isValid: (params: ParseBoundedNumberParams): boolean =>
    !isNil(parseBoundedNumber(params)),
};

type ParseBoundedNumberParams = {
  text: string;
  min: number;
  max: number;
  integer: boolean;
  exclusiveMin?: boolean;
};
