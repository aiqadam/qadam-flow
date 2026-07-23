import { ProjectMemberWithUser } from '@aiqadam/shared';

import { api } from '@/lib/api';

function list(projectId: string): Promise<ProjectMemberWithUser[]> {
  return api.get<ProjectMemberWithUser[]>('/v1/project-members', { projectId });
}

export const projectMemberApi = { list };
