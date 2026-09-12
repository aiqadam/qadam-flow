import { Field, FieldType } from '@aiqadam/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aiqadam/qadams-common')>();
  return { ...actual, httpClient: { sendRequest } };
});

function field({ externalId }: { externalId: string }): Field {
  return {
    id: `id_${externalId}`,
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-01T00:00:00.000Z',
    name: externalId,
    externalId,
    type: FieldType.TEXT,
    tableId: 'table_1',
    projectId: 'project_1',
  };
}

const fields: Field[] = [field({ externalId: 'title' }), field({ externalId: 'status' })];

async function run(rows: Record<string, unknown>[]) {
  const { updateRecords } = await import('../src/lib/actions/update-records');
  const { tablesCommon } = await import('../src/lib/common');
  vi.spyOn(tablesCommon, 'convertTableExternalIdToId').mockResolvedValue('table_1');
  vi.spyOn(tablesCommon, 'getTableFields').mockResolvedValue(fields);

  return updateRecords.run({
    propsValue: { table_id: 'events', values: { values: rows } },
    server: { apiUrl: 'https://example.invalid/api/', token: 'token', publicUrl: 'https://example.invalid/' },
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof updateRecords.run>[0]);
}

describe('tables-update-records', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ body: [] });
  });

  // The whole point of the action: N rows cost one request, not N step executions.
  it('sends every row in a single POST to the batch endpoint', async () => {
    await run([
      { __record_id: 'rec_1', title: 'a' },
      { __record_id: 'rec_2', title: 'b', status: 'done' },
    ]);

    expect(sendRequest).toHaveBeenCalledTimes(1);
    const request = sendRequest.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://example.invalid/api/v1/records/batch');
    expect(request.body).toEqual({
      tableId: 'table_1',
      records: [
        { id: 'rec_1', cells: [{ fieldId: 'id_title', value: 'a' }] },
        { id: 'rec_2', cells: [{ fieldId: 'id_title', value: 'b' }, { fieldId: 'id_status', value: 'done' }] },
      ],
    });
  });

  it('keeps a current value rather than blanking it, as the single-record action does', async () => {
    await run([{ __record_id: 'rec_1', title: 'a', status: '' }]);

    expect(sendRequest.mock.calls[0][0].body.records[0].cells).toEqual([{ fieldId: 'id_title', value: 'a' }]);
  });

  it('drops a value whose column is not in the table', async () => {
    await run([{ __record_id: 'rec_1', title: 'a', gone: 'x' }]);

    expect(sendRequest.mock.calls[0][0].body.records[0].cells).toEqual([{ fieldId: 'id_title', value: 'a' }]);
  });

  it.each([
    ['an empty batch', [], /Records is empty/],
    ['a row with no record id', [{ title: 'a' }], /missing a Record ID/],
    ['a row with a blank record id', [{ __record_id: '   ', title: 'a' }], /missing a Record ID/],
  ])('fails the step for %s and issues no request', async (_label, rows, message) => {
    await expect(run(rows)).rejects.toThrow(message);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});
