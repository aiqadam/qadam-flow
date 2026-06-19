import {
  httpClient,
  HttpHeaders,
  HttpMethod,
  HttpRequest,
  QueryParams,
} from '@aiqadam/qadams-common';
import { AppConnectionValueForAuthProperty } from '@aiqadam/qadams-framework';
import { metabaseAuth } from '..';

export async function queryMetabaseApi(
  params: {
    endpoint: string;
    method: HttpMethod;
    queryParams?: QueryParams;
    headers?: HttpHeaders;
    body?: object;
    responseType?: 'arraybuffer' | 'json' | 'blob' | 'text';
  },
  auth: AppConnectionValueForAuthProperty<typeof metabaseAuth>
) {
  const request: HttpRequest = {
    method: params.method,
    url: `${auth.props.baseUrl}/api/${params.endpoint}`,
    queryParams: params.queryParams,
    headers: {
      ...params.headers,
      'Content-Type': 'application/json',
      'X-API-KEY': auth.props.apiKey,
    },
    body: JSON.stringify(params.body),
    responseType: params.responseType,
  };
  const response = await httpClient.sendRequest(request);
  return response.body;
}
