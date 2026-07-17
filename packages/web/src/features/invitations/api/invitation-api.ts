import {
  InvitationStatus,
  InvitationType,
  SeekPage,
  SendUserInvitationRequest,
  UserInvitation,
  UserInvitationWithLink,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

type ListParams = {
  projectId?: string | null;
  type: InvitationType;
  status?: InvitationStatus;
  cursor?: string;
  limit?: number;
};

function accept({
  invitationToken,
}: {
  invitationToken: string;
}): Promise<void> {
  return api.post<void>('/v1/user-invitations/accept', { invitationToken });
}

function create(
  request: SendUserInvitationRequest,
): Promise<UserInvitationWithLink> {
  return api.post<UserInvitationWithLink>('/v1/user-invitations', request);
}

function list({
  projectId,
  type,
  status,
  cursor,
  limit,
}: ListParams): Promise<SeekPage<UserInvitation>> {
  return api.get<SeekPage<UserInvitation>>('/v1/user-invitations', {
    projectId,
    type,
    status,
    cursor,
    limit,
  });
}

function del(id: string): Promise<void> {
  return api.delete<void>(`/v1/user-invitations/${id}`);
}

export const invitationApi = { accept, create, list, del };
