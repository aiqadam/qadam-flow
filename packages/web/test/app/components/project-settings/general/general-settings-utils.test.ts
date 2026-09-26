import { describe, expect, it } from 'vitest';

import { generalSettingsUtils } from '@/app/components/project-settings/general/general-settings-utils';

describe('generalSettingsUtils.canShowDefaultLocale', () => {
  it('shows the field to anyone who can write the project — platform ADMIN/OPERATOR, the project owner, or a project-ADMIN member', () => {
    expect(
      generalSettingsUtils.canShowDefaultLocale({ canWriteProject: true }),
    ).toBe(true);
  });

  it('hides the field from a caller with no WRITE_PROJECT permission', () => {
    expect(
      generalSettingsUtils.canShowDefaultLocale({ canWriteProject: false }),
    ).toBe(false);
  });
});
