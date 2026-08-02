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
   * Both halves of the reference are needed and neither can stand in for the other.
   *
   * `providerId` addresses one row, so it is what the request is keyed and cached on: a platform
   * may hold several custom rows, and keying on the provider *name* served the second one the
   * first one's catalogue out of the query cache. `provider` is the type, which is what
   * `ALLOWED_CHAT_MODELS_BY_PROVIDER` is keyed on — a row id could not answer that.
   */
  useGetModelsForProvider: ({
    providerId,
    provider,
  }: GetModelsForProviderParams) => {
    return useQuery({
      queryKey: ['ai-models', providerId],
      enabled: !isNil(providerId) && !isNil(provider),
      queryFn: async () => {
        if (isNil(providerId) || isNil(provider)) return [];

        const allModels = await aiProviderApi.listModelsForProvider(providerId);

        return getAllowedModelsForProvider({
          provider,
          allModels,
          modelType: 'text',
        });
      },
    });
  },
};

type GetModelsForProviderParams = {
  providerId?: string;
  provider?: AIProviderName;
};

type GetAllowedModelsForProviderParams = {
  provider: AIProviderName;
  allModels: AIProviderModel[];
  modelType: AIModelType;
};
