// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { CORE_STEP_METADATA } from '@/features/qadams/utils/step-utils';

// `step-utils.tsx` builds `CORE_STEP_METADATA` with `t(...)` at module scope.
// That only resolves if the i18n instance is initialised first, which is why the
// module imports `t` from `@/i18n` rather than from `i18next`. Importing this
// module through `i18next` (as it used to) leaves every description `undefined`
// and crashes the qadam picker on `description.endsWith('.')`.
describe('CORE_STEP_METADATA', () => {
  it('resolves every core step label through i18n', () => {
    const entries = Object.values(CORE_STEP_METADATA);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.displayName).toBe('string');
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
