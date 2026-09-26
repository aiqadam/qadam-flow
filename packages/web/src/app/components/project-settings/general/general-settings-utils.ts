// `defaultLocale` is written server-side by `project-service.ts`'s `update()` to anyone who
// passes `callerCanAdministerProject` — platform ADMIN/OPERATOR, the project owner, and
// project-ADMIN members alike — with no `isPrivileged`-only check of its own (unlike
// `maxConcurrentJobs`, which the server does restrict to `isPrivileged`). `Permission.WRITE_PROJECT`
// is granted to exactly that same set (see `rolePermissions` + `project-member.service.ts`'s
// `getMyRole`, which mirrors the server's own bypass order), so gating this field's visibility on
// it — rather than on `platformRole === PlatformRole.ADMIN` — stops hiding a control from a TEAM
// project owner or project-ADMIN member who the server would already let write it.
const canShowDefaultLocale = ({
  canWriteProject,
}: {
  canWriteProject: boolean;
}): boolean => canWriteProject;

export const generalSettingsUtils = { canShowDefaultLocale };
