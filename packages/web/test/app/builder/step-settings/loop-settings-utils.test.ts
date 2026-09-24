import { describe, expect, it } from 'vitest';

import { loopSettingsUtils } from '@/app/builder/step-settings/loop-settings-utils';

// #387: a loop setting is saved as it is typed, and a value outside the API's bounds halts every
// later save; only in-bounds values are committed.
describe('loopSettingsUtils.parseBoundedNumber', () => {
  const concurrency = { min: 1, max: 100, integer: true };
  const window = { min: 0, max: 86400, integer: false, exclusiveMin: true };

  it('accepts an in-range whole number', () => {
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '5', ...concurrency }),
    ).toBe(5);
  });

  it('rejects empty, zero, fractions and values over the bound for a count', () => {
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '', ...concurrency }),
    ).toBeUndefined();
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '0', ...concurrency }),
    ).toBeUndefined();
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '1.5', ...concurrency }),
    ).toBeUndefined();
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '101', ...concurrency }),
    ).toBeUndefined();
  });

  it('accepts a fraction above an exclusive minimum, and not the minimum itself', () => {
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '0.5', ...window }),
    ).toBe(0.5);
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '0', ...window }),
    ).toBeUndefined();
    expect(
      loopSettingsUtils.parseBoundedNumber({ text: '0.', ...window }),
    ).toBeUndefined();
  });
});
