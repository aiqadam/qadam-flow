import { isNil, UserWithBadges } from '@aiqadam/shared';
import {
  QueryClient,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { t } from 'i18next';
import { toast } from 'sonner';

import { userApi } from '@/api/user-api';
import { authenticationSession } from '@/lib/authentication-session';

export const userHooks = {
  useCurrentUser: () => {
    const token = authenticationSession.getToken();
    const expired = authenticationSession.isJwtExpired(token!);
    return useSuspenseQuery<UserWithBadges | null, Error>({
      queryKey: ['currentUser'],
      queryFn: async () => {
        // Skip user data fetch if JWT is expired to prevent redirect to sign-in page
        // This is especially important for embedding scenarios where we need to accept
        // a new JWT token rather than triggering the global error handler

        if (expired) {
          return null;
        }
        try {
          const result = await userApi.getCurrentUser();
          return result;
        } catch (error) {
          console.error('Failed to fetch current user:', error);
          toast.error(t('Failed to load profile. Please refresh the page.'));
          throw error;
        }
      },
      staleTime: Infinity,
    });
  },
  useUserById: (id: string | null) => {
    return useQuery({
      queryKey: ['user', id],
      queryFn: async () => {
        try {
          return await userApi.getUserById(id!);
        } catch (error) {
          console.error(error);
          return null;
        }
      },
      enabled: !isNil(id),
      staleTime: Infinity,
    });
  },
  invalidateCurrentUser: (queryClient: QueryClient) => {
    queryClient.invalidateQueries({ queryKey: ['currentUser'] });
  },
  getCurrentUserPlatformRole: () => {
    const { data: user } = userHooks.useCurrentUser();
    return user?.platformRole;
  },
};

export const userMutations = {
  useUploadProfilePicture: ({
    onSuccess,
    onError,
  }: {
    onSuccess: () => void;
    onError: (error: Error) => void;
  }) => {
    return useMutation({
      mutationFn: (file: File) => userApi.updateMe(file),
      onSuccess,
      onError,
    });
  },
};
