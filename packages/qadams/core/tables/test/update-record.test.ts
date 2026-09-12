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

const fields: Field[] = [field({ externalId: 'checked_in_at' }), field({ externalId: 'status' })];

async function run({ values, onlyIf }: { values: Record<string, unknown>; onlyIf?: unknown }) {
  const { updateRecord } = await import('../src/lib/actions/update-record');
  const { tablesCommon } = await import('../src/lib/common');
  vi.spyOn(tablesCommon, 'convertTableExternalIdToId').mockResolvedValue('table_1');
  vi.spyOn(tablesCommon, 'getTableFields').mockResolvedValue(fields);

  return updateRecord.run({
    propsValue: { table_id: 'events', record_id: 'rec_1', values, only_if: onlyIf },
    server: { apiUrl: 'https://example.invalid/api/', token: 'token', publicUrl: 'https://example.invalid/' },
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof updateRecord.run>[0]);
}

describe('tables-update-record Only If', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ body: { id: 'rec_1', created: '', updated: '', cells: {} } });
  });

  // The prop can render and the condition can be silently dropped from the request,
  // which turns a compare-and-set back into an unconditional write with no signal.
  it('sends the condition as a precondition on the request', async () => {
    await run({
      values: { checked_in_at: '2026-09-11T09:00:00Z' },
      onlyIf: { filters: [{ field: 'checked_in_at', operator: 'not_exists' }] },
    });

    expect(sendRequest.mock.calls[0][0].body.precondition).toEqual([
      { fieldId: 'id_checked_in_at', operator: 'not_exists' },
    ]);
  });

  it('resolves an expected value the same way filters do', async () => {
    await run({
      values: { status: 'done' },
      onlyIf: { filters: [{ field: 'status', operator: 'eq', value: 'pending' }] },
    });

    expect(sendRequest.mock.calls[0][0].body.precondition).toEqual([
      { fieldId: 'id_status', operator: 'eq', value: 'pending' },
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['an empty condition list', { filters: [] }],
  ])('sends no precondition for %s, so the update stays unconditional', async (_label, onlyIf) => {
    await run({ values: { status: 'done' }, onlyIf });

    expect(sendRequest.mock.calls[0][0].body).not.toHaveProperty('precondition');
  });

  it('fails the step for a condition naming a column the table does not have', async () => {
    await expect(run({
      values: { status: 'done' },
      onlyIf: { filters: [{ field: 'no_such_column', operator: 'exists' }] },
    })).rejects.toThrow(/no_such_column/);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});
