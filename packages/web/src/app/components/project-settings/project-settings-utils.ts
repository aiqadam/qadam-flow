import { PlatformRole, ProjectType } from '@aiqadam/shared';

// Platform ADMIN unlocks the General tab unconditionally, not only when embedding is enabled — it
// is also where `maxConcurrentJobs` and the project's `defaultLocale` live, and neither of those
// is embedding-specific. Before this, an admin on a non-Team project with embedding off had no way
// to reach either field through this dialog.
const hasGeneralSettings = ({
  projectType,
  platformRole,
}: {
  projectType: ProjectType;
  platformRole: PlatformRole | null | undefined;
}): boolean =>
  projectType === ProjectType.TEAM || platformRole === PlatformRole.ADMIN;

export const projectSettingsUtils = { hasGeneralSettings };
