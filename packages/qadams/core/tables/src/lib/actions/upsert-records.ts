import { createAction, QadamAuth, Property } from '@aiqadam/qadams-framework';
import { tablesCommon } from '../common';
import { columnUtils } from '../common/columns';
import { AuthenticationType, httpClient, HttpMethod, propsValidation } from '@aiqadam/qadams-common';
import { UpsertAction, UpsertRecordsRequest } from '@aiqadam/shared';

// Namespaced because the sibling keys are column externalIds, which are caller-settable;
// per row because Values are per row (#506).
const CLEAR_KEY = '__clear';

export const upsertRecords = createAction({
  name: 'tables-upsert-records',
  displayName: 'Upsert Record(s)',
  description: 'Match records on a key and insert or update them, so repeating this step does not create a duplicate. The key is matched here, not enforced by the table — another write path can still insert one.',
  auth: QadamAuth.None(),
  props: {
    table_id: tablesCommon.table_id,
    key_columns: Property.MultiSelectDropdown({
      auth: QadamAuth.None(),
      displayName: 'Key Columns',
      description: 'The columns that identify a record. A row matching on these is updated; anything else is inserted.',
      required: true,
      refreshers: ['table_id'],
      options: async (propsValue, context) => {
        const tableExternalId = propsValue['table_id'];
        if (typeof tableExternalId !== 'string' || tableExternalId.length === 0) {
          return { options: [], disabled: true, placeholder: 'Select a table first.' };
        }
        try {
          const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);
          const fields = await tablesCommon.getTableFields({ tableId, context });
          return { options: fields.map((field) => ({ label: field.name, value: field.externalId })) };
        }
        catch (e) {
          console.error('Error fetching fields:', e);
          return { options: [], disabled: true, placeholder: 'Error loading columns. Please try again.' };
        }
      },
    }),
    values: Property.DynamicProperties({
      auth: QadamAuth.None(),
      displayName: 'Records',
      description: 'The records to insert or update. Every record must set each key column. A value left empty keeps the current one on an update; name a column in Clear Columns to empty it.',
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
            description: 'Add one or more records to insert or update',
            required: true,
            properties: {
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
    const { table_id: tableExternalId, key_columns, values, columns } = context.propsValue;
    const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);
    const tableFields = await tablesCommon.getTableFields({ tableId, context });
    const fieldValidations = tablesCommon.createFieldValidations(tableFields);

    const keyFieldIds = columnUtils.toWireFieldIds({ rawColumns: key_columns, fields: tableFields });
    if (keyFieldIds === undefined) {
      throw new Error('Key Columns is required: without a key there is nothing to match on, and every row would be inserted.');
    }

    const rows: Record<string, unknown>[] = values['values'] ?? [];
    if (rows.length === 0) {
      throw new Error('Records is empty. Add at least one record to upsert.');
    }

    const records: UpsertRecordsRequest['records'] = [];
    for (const [index, row] of rows.entries()) {
      const position = `Record #${index + 1}`;
      const setValues = Object.fromEntries(
        Object.entries(row).filter(([key, value]) => key !== CLEAR_KEY && value !== null && value !== undefined && value !== ''),
      );
      await propsValidation.validateZod(setValues, fieldValidations);

      const setCells = Object.entries(setValues).flatMap(([fieldExternalId, value]) => {
        const field = tableFields.find((candidate) => candidate.externalId === fieldExternalId);
        return field === undefined ? [] : [{ fieldId: field.id, value: String(value) }];
      });
      const clearFieldIds = columnUtils.toClearFieldIds({ rawColumns: row[CLEAR_KEY], fields: tableFields, position: `${position} Clear Columns` });
      columnUtils.assertNotSetAndCleared({ setFieldIds: setCells.map((cell) => cell.fieldId), clearFieldIds, fields: tableFields, position });
      assertNoKeyColumnCleared({ keyFieldIds, clearFieldIds, fields: tableFields, position });

      records.push([...setCells, ...clearFieldIds.map((fieldId) => ({ fieldId, value: '' }))]);
    }

    const fieldIds = columnUtils.toWireFieldIds({ rawColumns: columns, fields: tableFields });
    const request: UpsertRecordsRequest = { tableId, keyFieldIds, records, ...(fieldIds === undefined ? {} : { fieldIds }) };

    const response = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url: `${context.server.apiUrl}v1/records/upsert`,
      body: request,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
      retries: 5,
    });

    const results = response.body as { action: UpsertAction; record: Parameters<typeof tablesCommon.formatRecord>[0] }[];
    return results.map((result) => ({
      action: result.action,
      record: tablesCommon.formatRecord(result.record),
    }));
  },
});

// An empty key column is not "no value" to the matcher: it is a key component that
// matches the records whose column is also empty. Clearing one here would silently
// change which record the row is matched to rather than empty a cell.
function assertNoKeyColumnCleared({ keyFieldIds, clearFieldIds, fields, position }: { keyFieldIds: string[]; clearFieldIds: string[]; fields: { id: string; name: string }[]; position: string }): void {
  const clearedKeys = fields.filter((field) => keyFieldIds.includes(field.id) && clearFieldIds.includes(field.id));
  if (clearedKeys.length > 0) {
    throw new Error(`${position} clears key column ${clearedKeys.map((field) => `"${field.name}"`).join(', ')}. A key column is what the record is matched on and cannot be cleared by an upsert; use Update Record for that.`);
  }
}
