import { CreateApiKeyRequest } from '@aiqadam/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiKeysApi } from '../api/api-keys-api';

const API_KEYS_QUERY_KEY = ['api-keys'];

export const apiKeysHooks = {
  useList: () => {
    return useQuery({
      queryKey: API_KEYS_QUERY_KEY,
      queryFn: () => apiKeysApi.list(),
      meta: { showErrorDialog: true, loadSubsetOptions: {} },
    });
  },
};

export const apiKeysMutations = {
  useCreate: () => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (request: CreateApiKeyRequest) => apiKeysApi.create(request),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      },
    });
  },

  useDelete: () => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (id: string) => apiKeysApi.del(id),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      },
    });
  },
};
