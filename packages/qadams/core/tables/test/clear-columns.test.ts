import { Field, FieldType } from '@aiqadam/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aiqadam/qadams-common')>();
  return { ...actual, httpClient: { sendRequest } };
});

function field({ externalId, type }: { externalId: string; type: FieldType.TEXT | FieldType.DATE | FieldType.BOOLEAN }): Field {
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

// The ticket's own shape: a status plus the timestamps a transition has to be able to unset.
const fields: Field[] = [
  field({ externalId: 'status', type: FieldType.TEXT }),
  field({ externalId: 'cancelled_at', type: FieldType.DATE }),
  field({ externalId: 'confirmed', type: FieldType.BOOLEAN }),
];

const server = { apiUrl: 'https://example.invalid/api/', token: 'token', publicUrl: 'https://example.invalid/' };

async function mockMetadata() {
  const { tablesCommon } = await import('../src/lib/common');
  vi.spyOn(tablesCommon, 'convertTableExternalIdToId').mockResolvedValue('table_1');
  vi.spyOn(tablesCommon, 'getTableFields').mockResolvedValue(fields);
}

async function runUpdateRecord({ values, clear, columns }: { values: Record<string, unknown>; clear?: unknown; columns?: unknown }) {
  const { updateRecord } = await import('../src/lib/actions/update-record');
  await mockMetadata();
  return updateRecord.run({
    propsValue: { table_id: 'events', record_id: 'rec_1', values, clear_columns: clear, columns },
    server,
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof updateRecord.run>[0]);
}

async function runUpdateRecords({ rows, columns }: { rows: Record<string, unknown>[]; columns?: unknown }) {
  const { updateRecords } = await import('../src/lib/actions/update-records');
  await mockMetadata();
  return updateRecords.run({
    propsValue: { table_id: 'events', values: { values: rows }, columns },
    server,
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof updateRecords.run>[0]);
}

async function runUpsertRecords({ keyColumns, rows, columns }: { keyColumns: unknown; rows: Record<string, unknown>[]; columns?: unknown }) {
  const { upsertRecords } = await import('../src/lib/actions/upsert-records');
  await mockMetadata();
  return upsertRecords.run({
    propsValue: { table_id: 'events', key_columns: keyColumns, values: { values: rows }, columns },
    server,
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof upsertRecords.run>[0]);
}

function sentBody() {
  expect(sendRequest).toHaveBeenCalledTimes(1);
  return sendRequest.mock.calls[0][0].body;
}

beforeEach(() => {
  vi.restoreAllMocks();
  sendRequest.mockReset();
});

describe('tables-update-record Clear Columns (#506)', () => {
  beforeEach(() => {
    sendRequest.mockResolvedValue({ body: { id: 'rec_1', created: '', updated: '', cells: {} } });
  });

  // The ticket's failing run: a DATE cell could not be emptied at all, because the
  // only way to say "empty" was "" and the date validator rejected it.
  it('empties a DATE cell by sending an empty value for it', async () => {
    await runUpdateRecord({ values: { status: 'published', cancelled_at: '' }, clear: ['cancelled_at'] });

    expect(sentBody().cells).toEqual([
      { fieldId: 'id_status', value: 'published' },
      { fieldId: 'id_cancelled_at', value: '' },
    ]);
  });

  it.each([
    ['TEXT', 'status'],
    ['BOOLEAN', 'confirmed'],
  ])('empties a %s cell', async (_type, column) => {
    await runUpdateRecord({ values: {}, clear: [column] });

    expect(sentBody().cells).toEqual([{ fieldId: `id_${column}`, value: '' }]);
  });

  // The back-compat half of the design: an empty value is still "don't change".
  it('still keeps a cell whose value is left empty when it is not in Clear Columns', async () => {
    await runUpdateRecord({ values: { status: 'published', cancelled_at: '' } });

    expect(sentBody().cells).toEqual([{ fieldId: 'id_status', value: 'published' }]);
  });

  it.each([
    ['a display name list', ['cancelled_at']],
    ['the JSON list dynamic mode stores', '["cancelled_at","status"]'],
    ['a comma-separated string', 'cancelled_at, status'],
    ['an internal id', ['id_cancelled_at']],
  ])('accepts %s', async (_label, clear) => {
    await runUpdateRecord({ values: {}, clear });

    expect(sentBody().cells.map((cell: { fieldId: string }) => cell.fieldId)).toContain('id_cancelled_at');
  });

  // Clearing nothing is the safe side: a binding that resolves empty leaves the record alone.
  it.each([
    ['nothing', undefined],
    ['an empty list', []],
    ['the literal "[]" an untouched dynamic multi-select stores', '[]'],
    ['an empty string', ''],
  ])('clears nothing for %s', async (_label, clear) => {
    await runUpdateRecord({ values: { status: 'published' }, clear });

    expect(sentBody().cells).toEqual([{ fieldId: 'id_status', value: 'published' }]);
  });

  it('fails the step, naming the column, when a column is both set and cleared', async () => {
    await expect(runUpdateRecord({ values: { status: 'published' }, clear: ['status'] })).rejects.toThrow(/both sets and clears "status"/);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  // Dropping it would silently keep the very value the author asked to remove.
  it('fails the step for a column the table does not have', async () => {
    await expect(runUpdateRecord({ values: {}, clear: ['finished_at'] })).rejects.toThrow(/Clear Columns names column "finished_at", which this table does not have/);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});

describe('tables-update-record Columns', () => {
  beforeEach(() => {
    sendRequest.mockResolvedValue({ body: { id: 'rec_1', created: '', updated: '', cells: {} } });
  });

  it('asks the server for only the chosen columns', async () => {
    await runUpdateRecord({ values: { status: 'published' }, columns: ['status'] });

    expect(sentBody().fieldIds).toEqual(['id_status']);
  });

  it('sends no projection when Columns is unset, so every column comes back', async () => {
    await runUpdateRecord({ values: { status: 'published' } });

    expect(sentBody()).not.toHaveProperty('fieldIds');
  });
});

describe('tables-update-records Clear Columns (#506)', () => {
  beforeEach(() => {
    sendRequest.mockResolvedValue({ body: [] });
  });

  it('clears per row, so one batch can reactivate some records and leave others alone', async () => {
    await runUpdateRecords({
      rows: [
        { __record_id: 'rec_1', status: 'published', __clear: ['cancelled_at'] },
        { __record_id: 'rec_2', status: 'cancelled' },
      ],
    });

    expect(sentBody().records).toEqual([
      { id: 'rec_1', cells: [{ fieldId: 'id_status', value: 'published' }, { fieldId: 'id_cancelled_at', value: '' }] },
      { id: 'rec_2', cells: [{ fieldId: 'id_status', value: 'cancelled' }] },
    ]);
  });

  it('sends only the emptied cell for a row that only clears', async () => {
    await runUpdateRecords({ rows: [{ __record_id: 'rec_1', __clear: 'status' }] });

    expect(sentBody().records[0].cells).toEqual([{ fieldId: 'id_status', value: '' }]);
  });

  it('fails the step, naming the row, when a row both sets and clears a column', async () => {
    await expect(runUpdateRecords({
      rows: [
        { __record_id: 'rec_1', status: 'published' },
        { __record_id: 'rec_2', status: 'published', __clear: ['status'] },
      ],
    })).rejects.toThrow(/Record #2 both sets and clears "status"/);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('fails the step, naming the row, for a column the table does not have', async () => {
    await expect(runUpdateRecords({ rows: [{ __record_id: 'rec_1', __clear: ['finished_at'] }] })).rejects.toThrow(/Record #1 Clear Columns names column "finished_at"/);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('asks the server for only the chosen columns', async () => {
    await runUpdateRecords({ rows: [{ __record_id: 'rec_1', status: 'published' }], columns: ['status'] });

    expect(sentBody().fieldIds).toEqual(['id_status']);
  });
});

describe('tables-upsert-records Clear Columns (#506)', () => {
  beforeEach(() => {
    sendRequest.mockResolvedValue({ body: [] });
  });

  // The ticket's reactivation case: the upsert that reactivates a registration must be
  // able to remove the stale cancelled_at, or the timestamp contradicts the status.
  it('clears per row alongside the values it sets', async () => {
    await runUpsertRecords({
      keyColumns: ['status'],
      rows: [
        { status: 'active', __clear: ['cancelled_at', 'confirmed'] },
        { status: 'cancelled', cancelled_at: '2026-09-21T10:00:00Z' },
      ],
    });

    const body = sentBody();
    expect(body.records[0]).toEqual([
      { fieldId: 'id_status', value: 'active' },
      { fieldId: 'id_cancelled_at', value: '' },
      { fieldId: 'id_confirmed', value: '' },
    ]);
    expect(body.records[1].map((cell: { fieldId: string }) => cell.fieldId)).toEqual(['id_status', 'id_cancelled_at']);
  });

  // An empty key component matches the records whose column is also empty, so "clear"
  // would silently change which record the row is matched to.
  it('fails the step for a row that clears a key column', async () => {
    await expect(runUpsertRecords({
      keyColumns: ['status', 'cancelled_at'],
      rows: [{ status: 'active', __clear: ['cancelled_at'] }],
    })).rejects.toThrow(/Record #1 clears key column "cancelled_at"/);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('fails the step when a row both sets and clears a column', async () => {
    await expect(runUpsertRecords({
      keyColumns: ['status'],
      rows: [{ status: 'active', confirmed: true, __clear: ['confirmed'] }],
    })).rejects.toThrow(/Record #1 both sets and clears "confirmed"/);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('asks the server for only the chosen columns', async () => {
    await runUpsertRecords({ keyColumns: ['status'], rows: [{ status: 'active' }], columns: ['status'] });

    expect(sentBody().fieldIds).toEqual(['id_status']);
  });
});
