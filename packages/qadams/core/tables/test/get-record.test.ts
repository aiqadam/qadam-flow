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

const fields: Field[] = [field({ externalId: 'display_name' }), field({ externalId: 'phone' })];

async function run(columns: unknown) {
  const { getRecord } = await import('../src/lib/actions/get-record');
  const { tablesCommon } = await import('../src/lib/common');
  const convertTableExternalIdToId = vi.spyOn(tablesCommon, 'convertTableExternalIdToId').mockResolvedValue('table_1');
  const getTableFields = vi.spyOn(tablesCommon, 'getTableFields').mockResolvedValue(fields);

  const result = await getRecord.run({
    propsValue: { table_id: 'users', record_id: 'record_1', columns },
    server: { apiUrl: 'https://example.invalid/api/', token: 'token', publicUrl: 'https://example.invalid/' },
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof getRecord.run>[0]);

  return { result, convertTableExternalIdToId, getTableFields };
}

describe('tables-get-record', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ body: { id: 'record_1', created: '', updated: '', cells: {} } });
  });

  it('sends the resolved projection when Columns is set', async () => {
    await run(['phone']);

    const url: string = sendRequest.mock.calls[0][0].url;
    expect(url).toContain('fieldIds%5B0%5D=id_phone');
  });

  // A read with no projection must not pay for the table and field lookups, and
  // must not start failing because a table_id nothing used to read has drifted.
  it.each([
    ['undefined', undefined],
    ['an empty list', []],
  ])('resolves nothing and sends no projection when Columns is %s', async (_label, columns) => {
    const { convertTableExternalIdToId, getTableFields } = await run(columns);

    const url: string = sendRequest.mock.calls[0][0].url;
    expect(url).not.toContain('fieldIds');
    expect(convertTableExternalIdToId).not.toHaveBeenCalled();
    expect(getTableFields).not.toHaveBeenCalled();
  });

  it('fails the step for a column the table does not have', async () => {
    await expect(run(['no_such_column'])).rejects.toThrow(/no_such_column/);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});
