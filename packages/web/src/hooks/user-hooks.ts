import { isNil, UserWithBadges } from '@aiqadam/shared';
import {
  QueryClient,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { t } from 'i18next';

import { userApi } from '@/api/user-api';
import { useApErrorDialogStore } from '@/components/custom/ap-error-dialog/ap-error-dialog-store';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';

export const userHooks = {
  useCurrentUser: () => {
    const userId = authenticationSession.getCurrentUserId();
    const token = authenticationSession.getToken();
    const expired = authenticationSession.isJwtExpired(token!);
    const onboarding = authenticationSession.isOnboarding();
    return useSuspenseQuery<UserWithBadges | null, Error>({
      queryKey: ['currentUser', userId],
      queryFn: async () => {
        // Skip user data fetch if JWT is expired to prevent redirect to sign-in page
        // This is especially important for embedding scenarios where we need to accept
        // a new JWT token rather than triggering the global error handler

        // An ONBOARDING principal (issued right after sign-up, before a platform exists)
        // has no `platform` on it — GetCurrentUserRequest requires USER/SERVICE, and there
        // is no route that widens it, because the principal type itself can't carry a
        // platform id. Calling anyway means a guaranteed 403 on every render of
        // /create-platform, which react-query then retries with backoff.
        if (!userId || expired || onboarding) {
          return null;
        }
        try {
          const result = await userApi.getCurrentUser();
          return result;
        } catch (error) {
          console.error(error);
          // Unlike the expired-JWT case above, this is a real failure (network, 5xx, an
          // unexpectedly invalid session) and must not disappear into the console — the
          // caller (sidebar) would otherwise render as if there were deliberately no
          // profile block to show.
          const { openDialog } = useApErrorDialogStore.getState();
          openDialog({
            title: t('Failed to load data'),
            description: t(
              "We couldn't load your profile. Try refreshing the page.",
            ),
            error: {
              queryKey: ['currentUser', userId],
              details: api.isError(error)
                ? error.response?.data
                : String(error),
            },
          });
          return null;
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
    const userId = authenticationSession.getCurrentUserId();
    queryClient.invalidateQueries({ queryKey: ['currentUser', userId] });
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
