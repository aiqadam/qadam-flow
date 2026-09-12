import { createAction, QadamAuth, Property } from '@aiqadam/qadams-framework';
import { tablesCommon } from '../common';
import { columnUtils } from '../common/columns';
import { AuthenticationType, httpClient, HttpMethod, propsValidation } from '@aiqadam/qadams-common';
import { UpsertAction, UpsertRecordsRequest } from '@aiqadam/shared';

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
      description: 'The records to insert or update. Every record must set each key column.',
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

        return {
          values: Property.Array({
            displayName: 'Records',
            description: 'Add one or more records to insert or update',
            required: true,
            properties: fields,
          }),
        };
      },
    }),
  },
  async run(context) {
    const { table_id: tableExternalId, key_columns, values } = context.propsValue;
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
    for (const row of rows) {
      const setValues = Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== null && value !== undefined && value !== ''),
      );
      await propsValidation.validateZod(setValues, fieldValidations);

      records.push(Object.entries(setValues).flatMap(([fieldExternalId, value]) => {
        const field = tableFields.find((candidate) => candidate.externalId === fieldExternalId);
        return field === undefined ? [] : [{ fieldId: field.id, value: String(value) }];
      }));
    }

    const request: UpsertRecordsRequest = { tableId, keyFieldIds, records };

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
