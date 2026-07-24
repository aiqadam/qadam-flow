import {
  ApiKeyResponseWithValue,
  CreateApiKeyRequest,
  ResponseApiKey,
  SeekPage,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

function list(): Promise<SeekPage<ResponseApiKey>> {
  return api.get<SeekPage<ResponseApiKey>>('/v1/api-keys', { limit: 100 });
}

function create(
  request: CreateApiKeyRequest,
): Promise<ApiKeyResponseWithValue> {
  return api.post<ApiKeyResponseWithValue>('/v1/api-keys', request);
}

function del(id: string): Promise<void> {
  return api.delete<void>(`/v1/api-keys/${id}`);
}

export const apiKeysApi = { list, create, del };
