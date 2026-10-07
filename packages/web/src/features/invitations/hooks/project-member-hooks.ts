import { DefaultProjectRole } from '@aiqadam/shared';
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { projectMemberApi } from '../api/project-member-api';

export const projectMemberKeys = {
  list: (projectId: string) => ['project-members', projectId],
  candidates: (projectId: string) => ['project-member-candidates', projectId],
};

export const projectMemberQueries = {
  invalidate: ({
    queryClient,
    projectId,
  }: {
    queryClient: QueryClient;
    projectId: string;
  }) => {
    queryClient.invalidateQueries({
      queryKey: projectMemberKeys.list(projectId),
    });
    queryClient.invalidateQueries({
      queryKey: projectMemberKeys.candidates(projectId),
    });
  },
};

export const projectMemberHooks = {
  useList: (projectId: string) => {
    return useQuery({
      queryKey: projectMemberKeys.list(projectId),
      queryFn: () => projectMemberApi.list(projectId),
      meta: { showErrorDialog: true, loadSubsetOptions: {} },
    });
  },

  useListCandidates: ({
    projectId,
    enabled,
    search,
  }: {
    projectId: string;
    enabled: boolean;
    search?: string;
  }) => {
    return useQuery({
      queryKey: [...projectMemberKeys.candidates(projectId), search ?? ''],
      queryFn: () => projectMemberApi.listCandidates({ projectId, search }),
      enabled,
    });
  },
};

export const projectMemberMutations = {
  useUpdate: (projectId: string) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: ({
        memberId,
        projectRole,
      }: {
        memberId: string;
        projectRole: DefaultProjectRole;
      }) => projectMemberApi.update({ memberId, request: { projectRole } }),
      onSuccess: () => {
        projectMemberQueries.invalidate({ queryClient, projectId });
      },
    });
  },

  useRemove: (projectId: string) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (memberId: string) => projectMemberApi.remove(memberId),
      onSuccess: () => {
        projectMemberQueries.invalidate({ queryClient, projectId });
        // Removing a member revokes a pending invitation for the same email server-side.
        queryClient.invalidateQueries({ queryKey: ['invitations'] });
      },
    });
  },
};
