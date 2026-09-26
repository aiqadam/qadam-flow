import {
  ImportTranslationsRequestBody,
  ListTranslationsRequestQuery,
  UpsertTranslationsRequestBody,
} from '@aiqadam/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import {
  CURSOR_QUERY_PARAM,
  LIMIT_QUERY_PARAM,
} from '@/components/custom/data-table';
import { internalErrorToast } from '@/components/ui/sonner';

import { translationsApi } from '../api/translations';

type UseTranslationsProps = {
  request: ListTranslationsRequestQuery;
  extraKeys: unknown[];
  enabled?: boolean;
  showErrorDialog?: boolean;
};

export const translationsQueries = {
  useTranslations: ({
    request,
    extraKeys,
    enabled,
    showErrorDialog,
  }: UseTranslationsProps) => {
    return useQuery({
      queryKey: ['translations', ...extraKeys],
      meta: showErrorDialog
        ? { showErrorDialog: true, loadSubsetOptions: {} }
        : undefined,
      queryFn: () => translationsApi.list(request),
      enabled,
    });
  },

  useListSearchParams: () => {
    const { search } = useLocation();
    return useMemo(() => {
      const sp = new URLSearchParams(search);
      const limitParam = sp.get(LIMIT_QUERY_PARAM);
      return {
        cursor: sp.get(CURSOR_QUERY_PARAM) ?? undefined,
        limit: limitParam ? parseInt(limitParam) : 25,
        key: sp.get('key') ?? undefined,
        missing: sp.get('missing') === 'true',
      };
    }, [search]);
  },

  useUsages: (id: string | undefined) => {
    return useQuery({
      queryKey: ['translation-usages', id],
      queryFn: () => translationsApi.usages(id!),
      enabled: !!id,
    });
  },
};

export const translationsMutations = {
  // `onError` is optional and, when given, fully replaces the default toast (rather than
  // running alongside it — TanStack Query fires both a hook-level and a per-`mutate()`-call
  // callback, so a caller that wants to turn one error into a form field message must supply
  // its own hook-level `onError` here instead of a second one at the `mutate()` call site,
  // or the generic toast would still fire next to the specific message).
  useUpsertBatch: ({
    onSuccess,
    onError,
  }: {
    onSuccess: () => void;
    onError?: (error: Error) => void;
  }) =>
    useMutation({
      mutationFn: (request: UpsertTranslationsRequestBody) =>
        translationsApi.upsertBatch(request),
      onSuccess,
      onError: onError ?? (() => internalErrorToast()),
    }),

  useBulkDeleteTranslations: (refetch: () => void) =>
    useMutation({
      mutationFn: async (ids: string[]) => {
        await Promise.all(ids.map((id) => translationsApi.delete(id)));
      },
      onSuccess: () => {
        refetch();
        toast.success(t('Translation keys deleted'));
      },
      onError: () => {
        internalErrorToast();
      },
    }),

  useImport: ({
    onSuccess,
    onError,
  }: {
    onSuccess: (result: { importedKeys: number }) => void;
    onError: (error: Error) => void;
  }) =>
    useMutation({
      mutationFn: (request: ImportTranslationsRequestBody) =>
        translationsApi.import(request),
      onSuccess,
      onError,
    }),
};
