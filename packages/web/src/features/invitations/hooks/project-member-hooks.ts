import { useQuery } from '@tanstack/react-query';

import { projectMemberApi } from '../api/project-member-api';

function projectMemberQueryKey(projectId: string) {
  return ['project-members', projectId];
}

export const projectMemberHooks = {
  useList: (projectId: string) => {
    return useQuery({
      queryKey: projectMemberQueryKey(projectId),
      queryFn: () => projectMemberApi.list(projectId),
    });
  },
};
