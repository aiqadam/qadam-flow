import {
  isNil,
  Permission,
  PlatformRole,
  rolePermissions,
} from '@aiqadam/shared';
import { useQuery } from '@tanstack/react-query';

import { projectMemberApi } from '@/api/project-member-api';
import { userHooks } from '@/hooks/user-hooks';
import { authenticationSession } from '@/lib/authentication-session';

export const useAuthorization = () => {
  const projectId = authenticationSession.getProjectId();
  const { data: myRole, isPending } = useQuery({
    queryKey: ['project-member-role', projectId],
    queryFn: () => projectMemberApi.getMyRole(projectId!),
    enabled: !isNil(projectId),
    staleTime: Infinity,
  });

  // The server is the source of truth (403/PERMISSION_DENIED on every mutation), so this only
  // decides what to render. Defaulting to `true` while the role is loading (or there is no active
  // project yet, e.g. during onboarding) avoids a route guard bouncing a legitimate user to /404
  // for one render before the role query resolves — see `platformUserHooks.useUsers`, which is the
  // one existing consumer that already combines `checkAccess` with `isFetchingProjectRole` to gate
  // side-effecting queries rather than relying on `checkAccess` alone during the loading window.
  const checkAccess = (permission: Permission) => {
    if (isPending || isNil(myRole)) {
      return true;
    }
    return rolePermissions[myRole.role].includes(permission);
  };

  return { checkAccess, isFetchingProjectRole: isPending };
};

export const useIsPlatformAdmin = () => {
  const platformRole = userHooks.getCurrentUserPlatformRole();
  return platformRole === PlatformRole.ADMIN;
};
