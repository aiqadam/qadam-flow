import { ProjectMemberRoleResponse } from '@aiqadam/shared';

import { api } from '@/lib/api';

export const projectMemberApi = {
  getMyRole(projectId: string): Promise<ProjectMemberRoleResponse> {
    return api.get<ProjectMemberRoleResponse>('/v1/project-members/role', {
      projectId,
    });
  },
};
