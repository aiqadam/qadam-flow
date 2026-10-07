import {
  InvitationStatus,
  InvitationType,
  SendUserInvitationRequest,
} from '@aiqadam/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invitationApi } from '../api/invitation-api';

import { projectMemberKeys } from './project-member-hooks';

type UseListParams = {
  projectId?: string | null;
  type: InvitationType;
  status?: InvitationStatus;
};

function invitationQueryKey({ projectId, type, status }: UseListParams) {
  return ['invitations', projectId, type, status];
}

export const invitationHooks = {
  useList: ({ projectId, type, status }: UseListParams) => {
    return useQuery({
      queryKey: invitationQueryKey({ projectId, type, status }),
      queryFn: () => invitationApi.list({ projectId, type, status }),
      meta: { showErrorDialog: true, loadSubsetOptions: {} },
    });
  },
};

export const invitationMutations = {
  useCreate: () => {
    return useMutation({
      mutationFn: (request: SendUserInvitationRequest) =>
        invitationApi.create(request),
    });
  },

  useDelete: (projectId: string) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (id: string) => invitationApi.del(id),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['invitations'] });
        // Revoking a pending invitation makes that person a candidate again.
        queryClient.invalidateQueries({
          queryKey: projectMemberKeys.candidates(projectId),
        });
      },
    });
  },

  useAccept: () => {
    return useMutation({
      mutationFn: ({ invitationToken }: { invitationToken: string }) =>
        invitationApi.accept({ invitationToken }),
      onError: () => {
        // Handled inline by AcceptInvitationPage's isError branch.
      },
    });
  },
};
