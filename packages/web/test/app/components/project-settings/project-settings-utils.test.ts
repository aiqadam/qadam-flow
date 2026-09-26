import { PlatformRole, ProjectType } from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';

import { projectSettingsUtils } from '@/app/components/project-settings/project-settings-utils';

describe('projectSettingsUtils.hasGeneralSettings', () => {
  it('is true for a TEAM project regardless of platform role', () => {
    expect(
      projectSettingsUtils.hasGeneralSettings({
        projectType: ProjectType.TEAM,
        platformRole: null,
      }),
    ).toBe(true);
    expect(
      projectSettingsUtils.hasGeneralSettings({
        projectType: ProjectType.TEAM,
        platformRole: PlatformRole.MEMBER,
      }),
    ).toBe(true);
  });

  it('is true for a PERSONAL project when the caller is a platform ADMIN', () => {
    expect(
      projectSettingsUtils.hasGeneralSettings({
        projectType: ProjectType.PERSONAL,
        platformRole: PlatformRole.ADMIN,
      }),
    ).toBe(true);
  });

  it('is false for a PERSONAL project when the caller is not a platform ADMIN', () => {
    expect(
      projectSettingsUtils.hasGeneralSettings({
        projectType: ProjectType.PERSONAL,
        platformRole: PlatformRole.MEMBER,
      }),
    ).toBe(false);
    expect(
      projectSettingsUtils.hasGeneralSettings({
        projectType: ProjectType.PERSONAL,
        platformRole: null,
      }),
    ).toBe(false);
  });
});
