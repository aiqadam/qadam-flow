import { Alert, CreateAlertParams, SeekPage } from '@aiqadam/shared';

import { api } from '@/lib/api';

type ListParams = {
  projectId: string;
  cursor?: string;
  limit?: number;
};

function list(params: ListParams): Promise<SeekPage<Alert>> {
  return api.get<SeekPage<Alert>>('/v1/alerts', params);
}

function create(request: CreateAlertParams): Promise<Alert> {
  return api.post<Alert>('/v1/alerts', request);
}

function del(id: string): Promise<void> {
  return api.delete<void>(`/v1/alerts/${id}`);
}

export const alertsApi = { list, create, del };
