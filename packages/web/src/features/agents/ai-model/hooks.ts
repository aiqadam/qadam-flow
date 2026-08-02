import {
  AIProviderModel,
  AIProviderName,
  ALLOWED_CHAT_MODELS_BY_PROVIDER,
  isNil,
} from '@aiqadam/shared';
import { useQuery } from '@tanstack/react-query';

import { aiProviderApi } from '@/features/platform-admin/api/ai-provider-api';

type AIModelType = 'text' | 'image';

function getAllowedModelsForProvider({
  provider,
  allModels,
  modelType,
}: GetAllowedModelsForProviderParams): AIProviderModel[] {
  const allowedIds = ALLOWED_CHAT_MODELS_BY_PROVIDER[provider];

  return allModels
    .filter((model) => model.type === modelType)
    .filter((model) => {
      if (isNil(allowedIds)) {
        return true;
      }

      return allowedIds.includes(model.id);
    })
    .sort((a, b) => {
      if (isNil(allowedIds)) {
        return a.name.localeCompare(b.name);
      }
      const aIndex = allowedIds.indexOf(a.id);
      const bIndex = allowedIds.indexOf(b.id);
      return aIndex - bIndex;
    });
}

export const aiModelHooks = {
  useListProviders: () => {
    return useQuery({
      queryKey: ['ai-providers'],
      queryFn: () => aiProviderApi.list(),
    });
  },

  /**
   * Takes the whole row rather than its id and its type separately, because both halves are needed
   * and neither can stand in for the other — and passing them apart invites a caller to supply one
   * without the other, which is a state that cannot exist.
   *
   * The **id** addresses one row, so it is what the request is keyed and cached on: a platform may
   * hold several custom rows, and keying on the provider *name* served the second one the first
   * one's catalogue out of the query cache. The **type** is what `ALLOWED_CHAT_MODELS_BY_PROVIDER`
   * is keyed on, and a row id could not answer that.
   */
  useGetModelsForProvider: ({ row }: GetModelsForProviderParams) => {
    return useQuery({
      queryKey: ['ai-models', row?.id],
      enabled: !isNil(row),
      queryFn: async () => {
        if (isNil(row)) return [];

        const allModels = await aiProviderApi.listModelsForProvider(row.id);

        return getAllowedModelsForProvider({
          provider: row.provider,
          allModels,
          modelType: 'text',
        });
      },
    });
  },
};

type GetModelsForProviderParams = {
  row?: { id: string; provider: AIProviderName };
};

type GetAllowedModelsForProviderParams = {
  provider: AIProviderName;
  allModels: AIProviderModel[];
  modelType: AIModelType;
};
