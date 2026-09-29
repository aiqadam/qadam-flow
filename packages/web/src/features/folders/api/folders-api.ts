import {
  CreateFolderRequest,
  Folder,
  FolderDto,
  ListFolderRequest,
  SeekPage,
  UpdateFolderRequest,
} from '@aiqadam/shared';

import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';
import { seekPageUtils } from '@/lib/seek-page-utils';

export const foldersApi = {
  async list(): Promise<FolderDto[]> {
    const response = await seekPageUtils.listAll((page) => {
      const request: ListFolderRequest = {
        ...page,
        projectId: authenticationSession.getProjectId()!,
      };
      return api.get<SeekPage<FolderDto>>('/v1/folders', request);
    });
    return response.data;
  },
  get(folderId: string) {
    return api.get<Folder>(`/v1/folders/${folderId}`);
  },
  create(req: CreateFolderRequest) {
    return api.post<FolderDto>('/v1/folders', req);
  },
  delete(folderId: string) {
    return api.delete<void>(`/v1/folders/${folderId}`);
  },
  renameFolder(folderId: string, req: UpdateFolderRequest) {
    return api.post<Folder>(`/v1/folders/${folderId}`, req);
  },
};
