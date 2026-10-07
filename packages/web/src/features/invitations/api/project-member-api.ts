import {
  ProjectMemberCandidate,
  ProjectMemberWithUser,
  UpdateProjectMemberRequestBody,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

function list(projectId: string): Promise<ProjectMemberWithUser[]> {
  return api.get<ProjectMemberWithUser[]>('/v1/project-members', { projectId });
}

function listCandidates({
  projectId,
  search,
}: {
  projectId: string;
  search?: string;
}): Promise<ProjectMemberCandidate[]> {
  return api.get<ProjectMemberCandidate[]>('/v1/project-members/candidates', {
    projectId,
    search,
  });
}

function update({
  memberId,
  request,
}: {
  memberId: string;
  request: UpdateProjectMemberRequestBody;
}): Promise<ProjectMemberWithUser> {
  return api.post<ProjectMemberWithUser>(
    `/v1/project-members/${memberId}`,
    request,
  );
}

function remove(memberId: string): Promise<void> {
  return api.delete<void>(`/v1/project-members/${memberId}`);
}

export const projectMemberApi = { list, listCandidates, update, remove };
