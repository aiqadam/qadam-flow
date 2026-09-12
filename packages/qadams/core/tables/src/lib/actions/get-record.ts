import { createAction, QadamAuth } from '@aiqadam/qadams-framework';
import { tablesCommon } from '../common';
import { columnUtils } from '../common/columns';
import { AuthenticationType, httpClient, HttpMethod } from '@aiqadam/qadams-common';
import { GetRecordRequest, PopulatedRecord } from '@aiqadam/shared';
import qs from 'qs';

export const getRecord = createAction({
  name: 'tables-get-record',
  displayName: 'Get Record',
  description: 'Get single record by its id.',
  auth: QadamAuth.None(),
  props: {
    table_id: tablesCommon.table_id,
    record_id: tablesCommon.record_id,
    columns: tablesCommon.columns,
  },
  async run(context) {
    const { table_id: tableExternalId, record_id, columns } = context.propsValue;

    // Resolved only when a projection is asked for: this is a hot-path read, and
    // the two extra round-trips would otherwise be charged to every run — and would
    // fail a flow whose table_id drifted, which used to be a prop nothing read.
    const request: GetRecordRequest = {
      fieldIds: await resolveFieldIds({ tableExternalId, columns, context }),
    };

    const response = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${context.server.apiUrl}v1/records/${record_id}?${qs.stringify(request)}`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
      retries: 5,
    });

    return tablesCommon.formatRecord(response.body as PopulatedRecord);
  },
});

async function resolveFieldIds({ tableExternalId, columns, context }: { tableExternalId: string; columns: unknown; context: Parameters<typeof tablesCommon.convertTableExternalIdToId>[1] }): Promise<string[] | undefined> {
  if (columns === null || columns === undefined || (Array.isArray(columns) && columns.length === 0)) {
    return undefined;
  }
  const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);
  const tableFields = await tablesCommon.getTableFields({ tableId, context });
  return columnUtils.toWireFieldIds({ rawColumns: columns, fields: tableFields });
}
