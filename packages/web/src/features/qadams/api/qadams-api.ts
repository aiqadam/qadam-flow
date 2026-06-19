import {
  QadamMetadataModel,
  QadamMetadataModelSummary,
  QadamPackageInformation,
  PropertyType,
  ExecutePropsResult,
  InputPropertyMap,
} from '@aiqadam/qadams-framework';
import {
  AddQadamRequestBody,
  GetQadamRequestParams,
  GetQadamRequestQuery,
  ListQadamsRequestQuery,
  PackageType,
  QadamOptionRequest,
} from '@aiqadam/shared';
import { t } from 'i18next';

import { internalErrorToast } from '@/components/ui/sonner';
import { api } from '@/lib/api';

export const qadamsApi = {
  list(request: ListQadamsRequestQuery): Promise<QadamMetadataModelSummary[]> {
    return api.get<QadamMetadataModelSummary[]>('/v1/qadams', request);
  },
  get(
    request: GetQadamRequestParams & GetQadamRequestQuery,
  ): Promise<QadamMetadataModel> {
    return api.get<QadamMetadataModel>(`/v1/qadams/${request.name}`, {
      version: request.version ?? undefined,
      locale: request.locale ?? undefined,
      projectId: request.projectId ?? undefined,
    });
  },
  options<
    T extends
      | PropertyType.DROPDOWN
      | PropertyType.MULTI_SELECT_DROPDOWN
      | PropertyType.DYNAMIC,
  >(
    request: QadamOptionRequest,
    propertyType: T,
  ): Promise<ExecutePropsResult<T>> {
    return api
      .post<ExecutePropsResult<T>>(`/v1/qadams/options`, request)
      .catch((error) => {
        console.error(error);
        internalErrorToast();
        const defaultStateForDynamicProperty: ExecutePropsResult<PropertyType.DYNAMIC> =
          {
            options: {} as InputPropertyMap,
            type: PropertyType.DYNAMIC,
          };
        const defaultStateForDropdownProperty: ExecutePropsResult<PropertyType.DROPDOWN> =
          {
            options: {
              options: [],
              disabled: true,
              placeholder: t(
                'An internal error occurred, please contact support',
              ),
            },
            type: PropertyType.DROPDOWN,
          };
        return (
          propertyType === PropertyType.DYNAMIC
            ? defaultStateForDynamicProperty
            : defaultStateForDropdownProperty
        ) as ExecutePropsResult<T>;
      });
  },
  syncFromCloud() {
    return api.post<void>(`/v1/qadams/sync`, {});
  },
  async install(params: AddQadamRequestBody) {
    const formData = new FormData();
    formData.set('packageType', params.packageType);
    formData.set('qadamName', params.qadamName);
    formData.set('qadamVersion', params.qadamVersion);
    formData.set('scope', params.scope);
    if (params.packageType === PackageType.ARCHIVE) {
      const buffer = await (
        params.qadamArchive as unknown as File
      ).arrayBuffer();
      formData.append('qadamArchive', new Blob([buffer]));
    }

    return api.post<QadamMetadataModel>('/v1/qadams', formData, undefined, {
      'Content-Type': 'multipart/form-data',
    });
  },
  registry(release: string): Promise<QadamPackageInformation[]> {
    return api.get<QadamPackageInformation[]>('/v1/qadams/registry', {
      release,
    });
  },
  delete(id: string) {
    return api.delete(`/v1/qadams/${id}`);
  },
};
