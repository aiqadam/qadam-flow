import { createAction, QadamAuth, Property } from '@aiqadam/qadams-framework';
import { tablesCommon } from '../common';
import { AuthenticationType, httpClient, HttpMethod, propsValidation } from '@aiqadam/qadams-common';
import { PopulatedRecord, UpdateRecordRequest } from '@aiqadam/shared';
import { filterUtils } from '../common/filters';

// Spelled out because the conflict it produces is a normal outcome to branch on,
// not a bug: another run got there first.
const ONLY_IF_DESCRIPTION = [
  'Apply the update only if the record still matches these conditions, checked and written in one step.',
  'Use "Does not exist" to mean "only if this column is still empty" — that is how you write "record it only the first time".',
  'If a condition no longer holds the step fails with RECORD_PRECONDITION_FAILED rather than silently doing nothing.',
].join(' ');

export const updateRecord = createAction({
  name: 'tables-update-record',
  displayName: 'Update Record',
  description: 'Update values in an existing record',
  auth: QadamAuth.None(),
  props: {
    table_id: tablesCommon.table_id,
    record_id: tablesCommon.record_id,
    only_if: Property.DynamicProperties({
      auth: QadamAuth.None(),
      displayName: 'Only If',
      description: ONLY_IF_DESCRIPTION,
      required: false,
      refreshers: ['table_id'],
      props: async (propsValue, context) => {
        const table_id = propsValue['table_id'];
        if (!table_id || typeof table_id !== 'string') {
          return { filters: Property.Array({ displayName: 'Conditions', required: false, properties: {} }) };
        }
        const tableId = await tablesCommon.convertTableExternalIdToId(table_id, context);
        const fields = await tablesCommon.getTableFields({ tableId, context });
        return { filters: filterUtils.buildConditionProps({ fields }) };
      },
    }),
    values: Property.DynamicProperties({
      auth: QadamAuth.None(),
      displayName: 'Values',
      description: 'The values to update. Leave empty to keep current value.',
      required: true,
      refreshers: ['table_id'],
      props: async ({ table_id }, context) => {
        const tableExternalId = table_id as unknown as string;
        const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);
        if ((tableId ?? '').toString().length === 0) {
          return {};
        }

        return tablesCommon.createFieldProperties({ tableId, context });
      },
    }),
  },
  async run(context) {
    const { table_id: tableExternalId, record_id, values, only_if } = context.propsValue;
    const tableId = await tablesCommon.convertTableExternalIdToId(tableExternalId, context);

    const tableFields = await tablesCommon.getTableFields({ tableId, context });
    const fieldValidations = tablesCommon.createFieldValidations(tableFields);
    await propsValidation.validateZod(values, fieldValidations);

    const cells: UpdateRecordRequest['cells'] = Object.entries(values)
      .filter(([_, value]) => value !== null && value !== undefined && value !== '')
      .map(([fieldExternalId, value]) => ({
        fieldId: tableFields.find((field) => field.externalId === fieldExternalId)?.id ?? '',
        value,
      })).filter((cell) => cell.fieldId !== '');

    const precondition = filterUtils.toWireFilters({ rawFilters: only_if, fields: tableFields });

    const request: UpdateRecordRequest = {
      cells,
      tableId,
      ...(precondition.length === 0 ? {} : { precondition }),
    };

    const response = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url: `${context.server.apiUrl}v1/records/${record_id}`,
      body: request,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
      retries: 5,
    });

    return tablesCommon.formatRecord(response.body as PopulatedRecord);
  },
});
