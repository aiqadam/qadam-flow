import {
  AIProviderModel,
  AIProviderWithoutSensitiveData,
  CreateAIProviderRequest,
  UpdateAIProviderRequest,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

export const aiProviderApi = {
  list() {
    return api.get<AIProviderWithoutSensitiveData[]>('/v1/ai-providers');
  },
  // `providerRef`, not `provider`: the server's route parameter is `:providerRef` and accepts
  // either a row id or a provider name. The picker only ever sends a row id.
  listModelsForProvider(providerRef: string) {
    return api.get<AIProviderModel[]>(`/v1/ai-providers/${providerRef}/models`);
  },
  upsert(request: CreateAIProviderRequest): Promise<void> {
    return api.post('/v1/ai-providers', request);
  },
  update(providerId: string, request: UpdateAIProviderRequest): Promise<void> {
    return api.post(`/v1/ai-providers/${providerId}`, request);
  },
  delete(provider: string): Promise<void> {
    return api.delete(`/v1/ai-providers/${provider}`);
  },
};
