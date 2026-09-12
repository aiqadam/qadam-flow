import { createAction, QadamAuth, Property } from '@aiqadam/qadams-framework';
import { tablesCommon } from '../common';
import { columnUtils } from '../common/columns';
import { filterUtils } from '../common/filters';
import { AuthenticationType, httpClient, HttpMethod } from '@aiqadam/qadams-common';
import { FilterOperator, ListRecordsRequest, PopulatedRecord, SeekPage } from '@aiqadam/shared';
import qs from 'qs';

// Spelled out because this step is routinely configured as raw JSON through the
// API or MCP, where the builder's picker is not there to produce the shape.
const FILTERS_DESCRIPTION = [
  'Filter conditions to apply. All conditions are combined with AND.',
  'Shape: {"filters":[{"field":"<column name or id>","operator":"eq","value":"..."}]}.',
  'Operators: eq, neq, gt, gte, lt, lte, co, in, not_in, exists, not_exists.',
  'A filters value that cannot be read raises an error — it is never ignored, because ignoring it would return every row in the table.',
].join(' ');

const VALUE_DESCRIPTION = [
  'For "In" / "Not In", pass a comma-separated list or a list variable.',
  'Greater/Less Than compare by the column type: Number numerically, Date by timestamp (ISO, or any date the engine can parse — not epoch milliseconds), Text and Single Select alphabetically, ignoring case.',
  'A date without a time names the whole day in UTC, so "Less Than or Equal 2026-09-11" includes rows dated the 11th.',
].join(' ');

// An id list that was written but resolved to nothing must not read as "no
// restriction" — same rule as the Columns prop and as the filters themselves.
function toRecordIds(rawRecordIds: unknown): string[] | undefined {
  if (rawRecordIds === null || rawRecordIds === undefined || (Array.isArray(rawRecordIds) && rawRecordIds.length === 0)) {
    return undefined;
  }
  const ids = (Array.isArray(rawRecordIds) ? rawRecordIds : String(rawRecordIds).split(','))
    .map((id) => String(id ?? '').trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new Error('Record IDs is set but names no record. Remove it to search the whole table, or list the record ids to fetch.');
  }
  return [...new Set(ids)];
}

export const findRecords = createAction({
  name: 'tables-find-records',
  displayName: 'Find Records',
  description: 'Find records in a table with filters.',
  auth: QadamAuth.None(),
  props: {
    table_id: tablesCommon.table_id,
    columns: tablesCommon.columns,
    record_ids: Property.Array({
      displayName: 'Record IDs',
      description: 'Fetch only these records, by id. Leave empty to search the whole table. Combined with filters, a record must satisfy both.',
      required: false,
    }),
    limit: Property.Number({
      displayName: 'Limit',
      description: 'Maximum number of records to return (default no limit).',
      required: false,
    }),
    filters: Property.DynamicProperties({
      auth: QadamAuth.None(),
      displayName: 'Filters',
      description: FILTERS_DESCRIPTION,
      required: false,
      refreshers: ['table_id'],
      props: async (propsValue, context) => {
        const table_id = propsValue['table_id'];
        if (!table_id || typeof table_id !== 'string') {
          return {
            filters: Property.Array({
              displayName: 'Filters',
              required: false,
              properties: {},
            }),
          };
        }

        const convertedTableId = await tablesCommon.convertTableExternalIdToId(table_id, context);
        const fields = await tablesCommon.getTableFields({
          tableId: convertedTableId,
          context,
        });

        return {
          filters: Property.Array({
            displayName: 'Filters',
            required: false,
            properties: {
              field: Property.StaticDropdown({
                displayName: 'Field',
                required: true,
                options: {
                  options: fields.map((field) => ({
                    label: field.name,
                    value: { id: field.externalId, type: field.type, name: field.name },
                  })),
                },
              }),
              operator: Property.StaticDropdown({
                displayName: 'Operator',
                required: true,
                options: {
                  options: [
                    { label: 'Equals', value: FilterOperator.EQ },
                    { label: 'Not Equals', value: FilterOperator.NEQ },
                    { label: 'Greater Than', value: FilterOperator.GT },
                    { label: 'Greater Than or Equal', value: FilterOperator.GTE },
                    { label: 'Less Than', value: FilterOperator.LT },
                    { label: 'Less Than or Equal', value: FilterOperator.LTE },
                    { label: 'Contains', value: FilterOperator.CO },
                    { label: 'In', value: FilterOperator.IN },
                    { label: 'Not In', value: FilterOperator.NOT_IN },
                    { label: 'Exists', value: FilterOperator.EXISTS },
                    { label: 'Does not exist', value: FilterOperator.NOT_EXISTS },
                  ],
                },
              }),
              value: Property.ShortText({
                displayName: 'Value',
                description: VALUE_DESCRIPTION,
                required: false,
              }),
            },
          }),
        };
      },
    }),
  },
  async run(context) {
    const { table_id: tableExternalId, limit, filters, columns, record_ids } = context.propsValue;
    const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);
    const tableFields = await tablesCommon.getTableFields({ tableId, context });

    const request: ListRecordsRequest = {
      tableId,
      limit: limit ?? 999999999,
      cursor: undefined,
      filters: filterUtils.toWireFilters({ rawFilters: filters, fields: tableFields }),
      fieldIds: columnUtils.toWireFieldIds({ rawColumns: columns, fields: tableFields }),
      recordIds: toRecordIds(record_ids),
    };

    const response = await httpClient.sendRequest<SeekPage<PopulatedRecord>>({
      method: HttpMethod.GET,
      url: `${context.server.apiUrl}v1/records?${qs.stringify(request)}`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
      retries: 5,
    });

    return response.body.data.map(tablesCommon.formatRecord);
  },
});
