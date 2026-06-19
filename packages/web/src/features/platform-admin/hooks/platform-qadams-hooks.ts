import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { toast } from 'sonner';

import { platformApi } from '@/api/platforms-api';
import { qadamsApi } from '@/features/qadams';

export const platformPiecesMutations = {
  useToggleQadamVisibility: ({
    platformId,
    filteredQadamNames,
    refetch,
  }: {
    platformId: string;
    filteredQadamNames: string[];
    refetch: () => Promise<void>;
  }) => {
    return useMutation({
      mutationFn: async (qadamName: string) => {
        const newFilteredQadamNames = filteredQadamNames.includes(qadamName)
          ? filteredQadamNames.filter((name) => name !== qadamName)
          : [...filteredQadamNames, qadamName];
        await platformApi.update(
          { filteredQadamNames: newFilteredQadamNames },
          platformId,
        );
        await refetch();
      },
      onSuccess: () => {
        toast.success(t('Your changes have been saved.'), { duration: 3000 });
      },
    });
  },
  useTogglePiecePin: ({
    platformId,
    pinnedQadams,
    refetch,
  }: {
    platformId: string;
    pinnedQadams: string[];
    refetch: () => Promise<void>;
  }) => {
    return useMutation({
      mutationFn: async (qadamName: string) => {
        const newPinnedQadams = pinnedQadams.includes(qadamName)
          ? pinnedQadams.filter((name) => name !== qadamName)
          : [...pinnedQadams, qadamName];
        await platformApi.update({ pinnedQadams: newPinnedQadams }, platformId);
        await refetch();
      },
      onSuccess: () => {
        toast.success(t('Your changes have been saved.'), { duration: 3000 });
      },
    });
  },
  useSyncPieces: () => {
    return useMutation({
      mutationFn: async () => {
        await qadamsApi.syncFromCloud();
      },
      onSuccess: () => {
        toast.success(t('Qadams synced'), {
          description: t('Qadams have been synced from the cloud.'),
        });
      },
    });
  },
};
