import { createAction, QadamAuth, Property } from '@aiqadam/qadams-framework';
import { tablesCommon } from '../common';
import { columnUtils } from '../common/columns';
import { AuthenticationType, httpClient, HttpMethod, propsValidation } from '@aiqadam/qadams-common';
import { PopulatedRecord, UpdateRecordsRequest } from '@aiqadam/shared';

// Namespaced because the sibling keys in this map are column externalIds, and an
// externalId is caller-settable — a column called `record_id` would otherwise shadow
// this input and the row would be addressed by that column's value instead.
const RECORD_ID_KEY = '__record_id';
// Namespaced for the same reason, and per row because Values are per row: one batch
// can reactivate some records and leave others alone (#506).
const CLEAR_KEY = '__clear';

export const updateRecords = createAction({
  name: 'tables-update-records',
  displayName: 'Update Record(s)',
  description: 'Update many records in one request, instead of one step execution per record.',
  auth: QadamAuth.None(),
  props: {
    table_id: tablesCommon.table_id,
    values: Property.DynamicProperties({
      auth: QadamAuth.None(),
      displayName: 'Records',
      description: 'The records to update. Each entry needs the record ID and the values to set; leave a value empty to keep it, or name the column in Clear Columns to empty it.',
      required: true,
      refreshers: ['table_id'],
      props: async ({ table_id }, context) => {
        const tableExternalId = table_id as unknown as string;
        if ((tableExternalId ?? '').toString().length === 0) {
          return {};
        }
        const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);

        const fields = await tablesCommon.createFieldProperties({ tableId, context });
        if ('markdown' in fields) {
          return fields;
        }
        const tableFields = await tablesCommon.getTableFields({ tableId, context });

        return {
          values: Property.Array({
            displayName: 'Records',
            description: 'Add one or more records to update',
            required: true,
            properties: {
              [RECORD_ID_KEY]: Property.ShortText({
                displayName: 'Record ID',
                required: true,
              }),
              ...fields,
              [CLEAR_KEY]: Property.StaticMultiSelectDropdown({
                displayName: 'Clear Columns',
                description: tablesCommon.clearColumnsDescription,
                required: false,
                options: { options: tableFields.map((field) => ({ label: field.name, value: field.externalId })) },
              }),
            },
          }),
        };
      },
    }),
    columns: tablesCommon.columns,
  },
  async run(context) {
    const { table_id: tableExternalId, values, columns } = context.propsValue;
    const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);
    const tableFields = await tablesCommon.getTableFields({ tableId, context });
    const fieldValidations = tablesCommon.createFieldValidations(tableFields);

    const rows: Record<string, unknown>[] = values['values'] ?? [];
    if (rows.length === 0) {
      throw new Error('Records is empty. Add at least one record to update.');
    }

    const records: UpdateRecordsRequest['records'] = [];
    for (const [index, row] of rows.entries()) {
      const position = `Record #${index + 1}`;
      const recordId = row[RECORD_ID_KEY];
      if (typeof recordId !== 'string' || recordId.trim().length === 0) {
        throw new Error(`${position} is missing a Record ID.`);
      }

      // Same rule as the single-record action: an empty value keeps the current
      // one rather than writing an empty cell.
      const setValues = Object.fromEntries(
        Object.entries(row).filter(([key, value]) => key !== RECORD_ID_KEY && key !== CLEAR_KEY && value !== null && value !== undefined && value !== ''),
      );
      await propsValidation.validateZod(setValues, fieldValidations);

      const setCells = Object.entries(setValues).flatMap(([fieldExternalId, value]) => {
        const field = tableFields.find((candidate) => candidate.externalId === fieldExternalId);
        return field === undefined ? [] : [{ fieldId: field.id, value: value === null || value === undefined ? null : String(value) }];
      });
      const clearFieldIds = columnUtils.toClearFieldIds({ rawColumns: row[CLEAR_KEY], fields: tableFields, position: `${position} Clear Columns` });
      columnUtils.assertNotSetAndCleared({ setFieldIds: setCells.map((cell) => cell.fieldId), clearFieldIds, fields: tableFields, position });

      records.push({
        id: recordId.trim(),
        cells: [...setCells, ...clearFieldIds.map((fieldId) => ({ fieldId, value: '' }))],
      });
    }

    const fieldIds = columnUtils.toWireFieldIds({ rawColumns: columns, fields: tableFields });
    const request: UpdateRecordsRequest = { tableId, records, ...(fieldIds === undefined ? {} : { fieldIds }) };

    const response = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url: `${context.server.apiUrl}v1/records/batch`,
      body: request,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
      retries: 5,
    });

    return (response.body as PopulatedRecord[]).map(tablesCommon.formatRecord);
  },
});
