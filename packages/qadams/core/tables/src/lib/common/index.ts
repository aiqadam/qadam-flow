import { AuthenticationType, httpClient, HttpMethod } from "@aiqadam/qadams-common";
import { DynamicPropsValue, QadamAuth, Property } from "@aiqadam/qadams-framework";
import { assertNotNullOrUndefined, CreateTableWebhookRequest, Field, FieldType, MarkdownVariant, PopulatedRecord, SeekPage, StaticDropdownEmptyOption, SYNTHETIC_FLOW_RUN_IDS, Table, TableWebhookEventType, ListTablesRequest } from "@aiqadam/shared";
import { z } from 'zod';
import qs from 'qs';

// `run` is absent in property-builder contexts (options/DynamicProperties), which run in the
// builder rather than on the hot path — those simply skip the per-run metadata cache.
type ServerContext = { server: { apiUrl: string, token: string }, run?: { id: string }, project?: { id: string } }

type RunMetadata = {
  tableIds: Map<string, Promise<string>>
  fields: Map<string, Promise<Field[]>>
}

type ProjectServerContext = ServerContext & { project: { id: string } }

type FormattedRecord = {
  id: string;
  created: string;
  updated: string;
  cells: Record<string, {
    fieldName: string;
    updated: string;
    created: string;
    value: unknown;
  }>;
}
const getFieldTypeText = (fieldType: FieldType) => {
  switch (fieldType) {
    case FieldType.STATIC_DROPDOWN:
      return 'Single Select';
    case FieldType.DATE:
      return 'Date';
    case FieldType.NUMBER:
      return 'Number';
    case FieldType.TEXT:
      return 'Text';
  }
}
export const tablesCommon = {
  table_id: Property.Dropdown({
    auth: QadamAuth.None(),
    displayName: 'Table Name',
    required: true,
    refreshers: [],
    refreshOnSearch: true,
    options: async (_propsValue, context) => {
      try {
        const tables = await fetchAllTables(context);
        if (!Array.isArray(tables) || tables.length === 0) {
          return {
            options: [],
            disabled: true,
            placeholder: 'No tables found. Please create a table first.',
          };
        }
        return {
          options: tables.map((table: Table) => ({ label: table.name, value: table.externalId })),
        };
      } catch (e) {
        console.error('Error fetching tables:', e);
        return {
          options: [],
          disabled: true,
          placeholder: 'Error loading tables. Please try again.',
        };
      }
    },
  }),

  record_id: Property.ShortText({
    displayName: 'Record ID',
    description: 'The ID of the record to do the action on.',
    required: true,
  }),

  columns: Property.MultiSelectDropdown({
    auth: QadamAuth.None(),
    displayName: 'Columns',
    description: 'Columns to return. Leave empty to return every column. Step outputs are recorded verbatim in the run log, so reading only the columns you need is also what keeps the rest out of it.',
    required: false,
    refreshers: ['table_id'],
    options: async (propsValue, context) => {
      const tableExternalId = propsValue['table_id'];
      if (typeof tableExternalId !== 'string' || tableExternalId.length === 0) {
        return { options: [], disabled: true, placeholder: 'Select a table first.' };
      }
      try {
        const tableId = await resolveTableId({ tableExternalId, context });
        const fields = await fetchTableFields({ tableId, context });
        return { options: fields.map((field) => ({ label: field.name, value: field.externalId })) };
      }
      catch (e) {
        console.error('Error fetching fields:', e);
        return { options: [], disabled: true, placeholder: 'Error loading columns. Please try again.' };
      }
    },
  }),

  async getTableFields({ tableId, context }: { tableId: string, context: ServerContext }): Promise<Field[]> {
    return memoisePerRun({
      context,
      cache: (metadata) => metadata.fields,
      key: tableId,
      load: () => fetchTableFields({ tableId, context }),
    });
  },

  createFieldValidations(tableFields: Field[]) {
    const fieldValidations: Record<string, z.ZodType> = {};
    tableFields.forEach(field => {
      switch (field.type) {
        case FieldType.NUMBER:
          fieldValidations[field.externalId] = z.union([z.number(), z.string().transform(val => {
            const num = Number(val);
            if (isNaN(num)) throw new Error(`Invalid number for field "${field.name}"`);
            return num;
          })]).optional();
          break;
        case FieldType.DATE:
          fieldValidations[field.externalId] = z.union([z.date(), z.string().transform(val => {
            const date = new Date(val);
            if (isNaN(date.getTime())) throw new Error(`Invalid date for field "${field.name}"`);
            return date;
          })]).optional();
          break;
        default:
          fieldValidations[field.externalId] = z.string().optional();
      }
    });
    return fieldValidations;
  },

  async createFieldProperties({ tableId, context }: { tableId: string, context: { server: { apiUrl: string, token: string } } }): Promise<DynamicPropsValue> {
    const fields: DynamicPropsValue = {};

    try {
      const tableFields = await this.getTableFields({ tableId, context });
      if (!Array.isArray(tableFields) || tableFields.length === 0) {
        fields['markdown'] = Property.MarkDown({
          value: `We couldn't find any fields in the selected table. Please add fields to the table first.`,
          variant: MarkdownVariant.INFO,
        });
        return fields;
      }

      for (const field of tableFields) {
        const description = getFieldTypeText(field.type);

        switch (field.type) {
          case FieldType.NUMBER:
            fields[field.externalId] = Property.Number({
              displayName: field.name,
              description,
              required: false,
            });
            break;
          case FieldType.DATE:
            fields[field.externalId] = Property.DateTime({
              displayName: field.name,
              description,
              required: false,
            });
            break;
          case FieldType.STATIC_DROPDOWN:
            fields[field.externalId] = Property.StaticDropdown({
              displayName: field.name,
              description,
              defaultValue:'',
              required: false,
              options: {
                options:[StaticDropdownEmptyOption,...field.data.options.map(option => ({ label: option.value, value: option.value }))],
              },
            });
            break;
          default:
            fields[field.externalId] = Property.ShortText({
              displayName: field.name,
              description,
              required: false,
              defaultValue: '',
            });
            break;
        }
      }

      return fields;
    } catch (e) {
      console.error('Error fetching fields:', e);
      fields['markdown'] = Property.MarkDown({
        value: `We couldn't find any fields in the selected table. Please add fields to the table first.`,
        variant: MarkdownVariant.INFO,
      });

      return fields;
    }
  },

  async createWebhook({
    tableId,
    events,
    webhookUrl,
    flowId,
    server,
  }: {
    tableId: string;
    events: TableWebhookEventType[];
    webhookUrl: string;
    flowId: string;
    server: { apiUrl: string, token: string };
  }) {
    const request: CreateTableWebhookRequest = {
      events,
      webhookUrl,
      flowId,
    }
    const response = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url: `${server.apiUrl}v1/tables/${tableId}/webhooks`,
      body: request,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: server.token,
      },
    });

    return response.body;
  },

  async deleteWebhook({
    tableId,
    webhookId,
    server,
  }: {
    tableId: string;
    webhookId: string;
    server: { apiUrl: string, token: string };
  }) {
    const response = await httpClient.sendRequest({
      method: HttpMethod.DELETE,
      url: `${server.apiUrl}v1/tables/${tableId}/webhooks/${webhookId}`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: server.token,
      },
    });

    return response.body;
  },

  async getRecentRecords({
    tableId,
    limit = 5,
    context
  }: {
    tableId: string,
    limit?: number,
    context: { server: { apiUrl: string, token: string } }
  }) {
    if ((tableId ?? '').toString().length === 0) {
        throw new Error(JSON.stringify({
            message: 'Please add some records to the table before testing this trigger'
        }))
    }

    const response = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${context.server.apiUrl}v1/records?tableId=${tableId}&limit=${limit}`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
    });

    return response.body.data.map(this.formatRecord);

  },
  formatRecord(record: PopulatedRecord | { record: PopulatedRecord }): FormattedRecord {
    const actualRecord = 'record' in record ? record.record : record;
    
    return {
      id: actualRecord.id,
      created: actualRecord.created,
      updated: actualRecord.updated,
      cells: actualRecord.cells ? Object.fromEntries(Object.entries(actualRecord.cells).map(([fieldId, cell]) => {
        return [fieldId, {
          fieldName: cell.fieldName,
          updated: cell.updated,
          created: cell.created,
          value: cell.value 
        }]
      })) : {},
    }
  },

  async convertTableExternalIdToId(tableId: string, context: ProjectServerContext): Promise<string> {
    return memoisePerRun({
      context,
      cache: (metadata) => metadata.tableIds,
      key: tableId,
      load: () => resolveTableId({ tableExternalId: tableId, context }),
    });
  }
}

export const csvUtils = {
  buildCsv({ fields, rows, includeHeaders }: { fields: { name: string }[], rows: Record<string, string>[], includeHeaders: boolean }): string {
    const columnNames = fields.map((f) => f.name);
    const lines: string[] = [];

    if (includeHeaders) {
      lines.push(columnNames.map(this.escapeCsvCell).join(','));
    }

    for (const row of rows) {
      lines.push(columnNames.map((name) => this.escapeCsvCell(row[name] ?? '')).join(','));
    }

    return lines.join('\n');
  },

  escapeCsvCell(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  },
}

// No tables action creates, renames or deletes a field, so a table's id and its field schema do
// not move under a run that only uses this qadam — while every step after the first pays two HTTP
// round-trips for metadata it already resolved. Memoised per run, which keeps a schema edit
// visible to the very next run. The engine process outlives individual runs, hence the bound and
// the FIFO eviction.
//
// Two cases the premise does not cover, both silent rather than loud: a CODE or HTTP step in the
// same flow calling POST /v1/fields, and a run that pauses on a waitpoint and resumes after a UI
// schema edit. Both leave later steps validating against the pre-edit schema, where a value
// written to a new column is dropped by createFieldValidations rather than rejected.
//
// Both maps are keyed by table id alone because the bucket they live in is already scoped to one
// project — do not widen that bucket without prefixing these keys.
//
// The bucket is keyed by project as well as by run, because a run id on its own is not a tenant
// boundary: the engine hands out one fixed string for every execution that is not a flow run
// (SYNTHETIC_FLOW_RUN_IDS), so an MCP tool call in one project and one in another arrive under
// the same id. Those executions skip the cache entirely — the id never changes, so an entry made
// under it would never be evicted by a newer run and a schema edit would stay invisible.
const runMetadataCache = new Map<string, RunMetadata>();

const getRunMetadata = (cacheKey: string): RunMetadata => {
  const cached = runMetadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const created: RunMetadata = { tableIds: new Map(), fields: new Map() };
  runMetadataCache.set(cacheKey, created);
  const oldestKey = runMetadataCache.keys().next();
  if (runMetadataCache.size > RUN_METADATA_CACHE_MAX_RUNS && !oldestKey.done) {
    runMetadataCache.delete(oldestKey.value);
  }
  return created;
};

// A rejected lookup must not be remembered: the next step would inherit a failure that may have
// been a transient one, and would never retry it.
const memoisePerRun = <T>({ context, cache, key, load }: {
  context: ServerContext
  cache: (metadata: RunMetadata) => Map<string, Promise<T>>
  key: string
  load: () => Promise<T>
}): Promise<T> => {
  const runId = context.run?.id;
  const projectId = context.project?.id;
  if (!runId || !projectId || SYNTHETIC_FLOW_RUN_IDS.includes(runId)) {
    return load();
  }
  const entries = cache(getRunMetadata(`${projectId}:${runId}`));
  const cached = entries.get(key);
  if (cached) {
    return cached;
  }
  const pending = load().catch((error) => {
    entries.delete(key);
    throw error;
  });
  entries.set(key, pending);
  return pending;
};

const fetchTableFields = async ({ tableId, context }: { tableId: string, context: ServerContext }): Promise<Field[]> => {
  const fieldsResponse = await httpClient.sendRequest({
    method: HttpMethod.GET,
    url: `${context.server.apiUrl}v1/fields`,
    queryParams: {
      tableId,
    },
    authentication: {
      type: AuthenticationType.BEARER_TOKEN,
      token: context.server.token,
    },
  });

  return fieldsResponse.body as Field[];
}

const resolveTableId = async ({ tableExternalId, context }: { tableExternalId: string, context: ProjectServerContext }): Promise<string> => {
  const list: ListTablesRequest = {
    externalIds: [tableExternalId],
    projectId: context.project.id,
  }

  const res = await httpClient.sendRequest({
    method: HttpMethod.GET,
    url: `${context.server.apiUrl}v1/tables?${qs.stringify(list)}`,
    authentication: {
      type: AuthenticationType.BEARER_TOKEN,
      token: context.server.token,
    },
  });
  const table = (res.body as SeekPage<Table>).data[0];
  assertNotNullOrUndefined(table, `Table with externalId ${tableExternalId} not found`);
  return table.id;
}

const fetchAllTables = async (context: { server: { apiUrl: string, token: string }, project: { id: string } }): Promise<Table[]> => {
  const res = await httpClient.sendRequest({
    method: HttpMethod.GET,
    url: `${context.server.apiUrl}v1/tables?limit=100&projectId=${context.project.id}`,
    authentication: {
      type: AuthenticationType.BEARER_TOKEN,
      token: context.server.token,
    },
  });
  const resultBody = res.body as SeekPage<Table>
  const tables = [...resultBody.data];
  if (!Array.isArray(tables) || tables.length === 0) {
    return [];
  }
  let next = resultBody.next;
  while (next) {
    const nextPage = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${context.server.apiUrl}v1/tables?cursor=${next}&limit=100&projectId=${context.project.id}`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: context.server.token,
      },
    });
    const nextPageBody = nextPage.body as SeekPage<Table>
    tables.push(...nextPageBody.data)
    next = nextPageBody.next
  }
  return tables;
}

// Exported so the eviction test asserts against the real bound rather than a copy of it.
export const RUN_METADATA_CACHE_MAX_RUNS = 50;
