import {
  ExportTranslationsRequestQuery,
  GetTranslationUsagesResponse,
  ImportTranslationsRequestBody,
  ListTranslationsRequestQuery,
  SeekPage,
  Translation,
  UpsertTranslationsRequestBody,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

export const translationsApi = {
  list(request: ListTranslationsRequestQuery): Promise<SeekPage<Translation>> {
    return api.get<SeekPage<Translation>>('/v1/translations', request);
  },
  upsertBatch(request: UpsertTranslationsRequestBody): Promise<Translation[]> {
    return api.post<Translation[]>('/v1/translations', request);
  },
  delete(id: string): Promise<void> {
    return api.delete<void>(`/v1/translations/${id}`);
  },
  usages(id: string): Promise<GetTranslationUsagesResponse> {
    return api.get<GetTranslationUsagesResponse>(
      `/v1/translations/${id}/usages`,
    );
  },
  import(
    request: ImportTranslationsRequestBody,
  ): Promise<{ importedKeys: number; removedFromLocale: number }> {
    return api.post<{ importedKeys: number; removedFromLocale: number }>(
      '/v1/translations/import',
      request,
    );
  },
  exportAll(
    request: ExportTranslationsRequestQuery,
  ): Promise<{ translations: Record<string, unknown> }> {
    return api.get<{ translations: Record<string, unknown> }>(
      '/v1/translations/export',
      request,
    );
  },
};
