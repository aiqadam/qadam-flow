import { CreateAlertParams } from '@aiqadam/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { alertsApi } from '../api/alerts-api';

function alertsQueryKey(projectId: string) {
  return ['alerts', projectId];
}

export const alertsHooks = {
  useList: ({
    projectId,
    enabled = true,
  }: {
    projectId: string;
    enabled?: boolean;
  }) => {
    return useQuery({
      queryKey: alertsQueryKey(projectId),
      queryFn: () => alertsApi.list({ projectId, limit: 100 }),
      enabled,
    });
  },
};

export const alertsMutations = {
  useCreate: (projectId: string) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (request: CreateAlertParams) => alertsApi.create(request),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: alertsQueryKey(projectId) });
      },
    });
  },

  useDelete: (projectId: string) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (id: string) => alertsApi.del(id),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: alertsQueryKey(projectId) });
      },
    });
  },
};
