import { AIProviderModel, isChatModel, isNil } from '@aiqadam/shared';
import { useQuery } from '@tanstack/react-query';

import { aiProviderApi } from '@/features/platform-admin/api/ai-provider-api';

// The chat and the agent step both offer exactly the models that can hold a conversation. The
// capability comes from the provider's own catalogue, so a model added or retired after this code
// shipped is offered or hidden the day the provider reports it — which is what the old hardcoded
// allow-list got wrong (#848). The provider's own order is kept: it is the order the zero-config
// default (`pickDefaultChatModel`) and the server both read, so the picker and the chat agree.
function getChatModels({
  allModels,
}: {
  allModels: AIProviderModel[];
}): AIProviderModel[] {
  return allModels.filter((model) =>
    isChatModel({ capabilities: model.capabilities }),
  );
}

export const aiModelHooks = {
  useListProviders: () => {
    return useQuery({
      queryKey: ['ai-providers'],
      queryFn: () => aiProviderApi.list(),
    });
  },

  /**
   * Takes the whole row rather than just its id, because the request is keyed on the row id and a
   * caller that already holds the row should not have to unpack it. The **id** addresses one row: a
   * platform may hold several custom rows, and keying on the provider *name* served the second one
   * the first one's catalogue out of the query cache.
   */
  useGetModelsForProvider: ({ row }: GetModelsForProviderParams) => {
    return useQuery({
      queryKey: ['ai-models', row?.id],
      enabled: !isNil(row),
      queryFn: async () => {
        if (isNil(row)) return [];

        const allModels = await aiProviderApi.listModelsForProvider(row.id);

        return getChatModels({ allModels });
      },
    });
  },
};

type GetModelsForProviderParams = {
  row?: { id: string };
};
