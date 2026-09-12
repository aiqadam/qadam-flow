import { Field, FieldType } from '@aiqadam/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aiqadam/qadams-common')>();
  return { ...actual, httpClient: { sendRequest } };
});

function field({ externalId, type = FieldType.TEXT }: { externalId: string; type?: FieldType.TEXT | FieldType.NUMBER }): Field {
  return {
    id: `id_${externalId}`,
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-01T00:00:00.000Z',
    name: externalId,
    externalId,
    type,
    tableId: 'table_1',
    projectId: 'project_1',
  };
}

const fields: Field[] = [
  field({ externalId: 'event_id' }),
  field({ externalId: 'phone' }),
  field({ externalId: 'seats', type: FieldType.NUMBER }),
];

async function run({ keyColumns, rows }: { keyColumns: unknown; rows: Record<string, unknown>[] }) {
  const { upsertRecords } = await import('../src/lib/actions/upsert-records');
  const { tablesCommon } = await import('../src/lib/common');
  vi.spyOn(tablesCommon, 'convertTableExternalIdToId').mockResolvedValue('table_1');
  vi.spyOn(tablesCommon, 'getTableFields').mockResolvedValue(fields);

  return upsertRecords.run({
    propsValue: { table_id: 'events', key_columns: keyColumns, values: { values: rows } },
    server: { apiUrl: 'https://example.invalid/api/', token: 'token', publicUrl: 'https://example.invalid/' },
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof upsertRecords.run>[0]);
}

describe('tables-upsert-records', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ body: [{ action: 'created', record: { id: 'rec_1', created: '', updated: '', cells: {} } }] });
  });

  it('is registered on the qadam', async () => {
    const { tables } = await import('../src/index');
    expect(Object.keys(tables.actions())).toContain('tables-upsert-records');
  });

  // Unit tests on columnUtils stay green if the action stops calling it, and the
  // action can be unwired entirely — that is how three previous PRs shipped a
  // silently-disconnected feature.
  it('posts to the upsert endpoint with the key columns resolved to internal ids', async () => {
    await run({ keyColumns: ['event_id'], rows: [{ event_id: 'e1', phone: '+1', seats: 3 }] });

    expect(sendRequest).toHaveBeenCalledTimes(1);
    const request = sendRequest.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://example.invalid/api/v1/records/upsert');
    expect(request.body).toEqual({
      tableId: 'table_1',
      keyFieldIds: ['id_event_id'],
      records: [[
        { fieldId: 'id_event_id', value: 'e1' },
        { fieldId: 'id_phone', value: '+1' },
        // Coerced to a string on the wire, because a cell value is a varchar.
        { fieldId: 'id_seats', value: '3' },
      ]],
    });
  });

  it('strips an empty value and drops a column the table does not have', async () => {
    await run({ keyColumns: ['event_id'], rows: [{ event_id: 'e1', phone: '', gone: 'x' }] });

    expect(sendRequest.mock.calls[0][0].body.records[0]).toEqual([{ fieldId: 'id_event_id', value: 'e1' }]);
  });

  it('returns the per-row outcome, which is the whole point of asking', async () => {
    const result = await run({ keyColumns: ['event_id'], rows: [{ event_id: 'e1' }] });

    expect(result).toEqual([{ action: 'created', record: { id: 'rec_1', created: '', updated: '', cells: {} } }]);
  });

  it.each([
    ['no key columns', { keyColumns: [], rows: [{ event_id: 'e1' }] }, /Key Columns is required/],
    ['no records', { keyColumns: ['event_id'], rows: [] }, /Records is empty/],
    ['a key column the table does not have', { keyColumns: ['no_such_column'], rows: [{ event_id: 'e1' }] }, /no_such_column/],
  ])('fails the step for %s and issues no request', async (_label, params, message) => {
    await expect(run(params)).rejects.toThrow(message);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});
