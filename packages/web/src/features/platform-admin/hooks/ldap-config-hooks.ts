import { LdapTestRequest, UpsertLdapConfigRequest } from '@aiqadam/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ldapConfigApi } from '../api/ldap-config-api';

export const ldapConfigKeys = {
  all: ['ldap-config'] as const,
};

export const ldapConfigQueries = {
  useLdapConfig: () =>
    useQuery({
      queryKey: ldapConfigKeys.all,
      queryFn: () => ldapConfigApi.get(),
    }),
};

export const ldapConfigMutations = {
  useUpsertLdapConfig: ({
    onSuccess,
    onError,
  }: {
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
  } = {}) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (request: UpsertLdapConfigRequest) =>
        ldapConfigApi.upsert(request),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ldapConfigKeys.all });
        onSuccess?.();
      },
      onError,
    });
  },
  useDeleteLdapConfig: ({ onSuccess }: { onSuccess?: () => void } = {}) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: () => ldapConfigApi.delete(),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ldapConfigKeys.all });
        onSuccess?.();
      },
    });
  },
  useTestLdapConfig: () =>
    useMutation({
      mutationFn: (request: LdapTestRequest) => ldapConfigApi.test(request),
    }),
};
