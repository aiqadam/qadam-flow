import { Field, FieldType } from '@aiqadam/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aiqadam/qadams-common')>();
  return { ...actual, httpClient: { sendRequest } };
});

const fields: Field[] = [{
  id: 'id_event_id',
  created: '2026-09-01T00:00:00.000Z',
  updated: '2026-09-01T00:00:00.000Z',
  name: 'event_id',
  externalId: 'event_id',
  type: FieldType.TEXT,
  tableId: 'table_1',
  projectId: 'project_1',
}];

// The unit tests for `filterUtils` stay green if `find-records` stops calling it,
// which is exactly how the reported bug shipped. This exercises the action.
async function run(filters: unknown) {
  const { findRecords } = await import('../src/lib/actions/find-records');
  const { tablesCommon } = await import('../src/lib/common');
  vi.spyOn(tablesCommon, 'convertTableExternalIdToId').mockResolvedValue('table_1');
  vi.spyOn(tablesCommon, 'getTableFields').mockResolvedValue(fields);

  return findRecords.run({
    propsValue: { table_id: 'events', limit: undefined, filters },
    server: { apiUrl: 'https://example.invalid/api/', token: 'token', publicUrl: 'https://example.invalid/' },
    project: { id: 'project_1' },
  } as unknown as Parameters<typeof findRecords.run>[0]);
}

describe('tables-find-records', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ body: { data: [] } });
  });

  it.each([
    ['the reported fieldName shape', { filters: [{ fieldName: 'no_such_column', operator: 'eq', value: 'demo' }] }],
    ['an unreadable value', { scope: 'tenant' }],
    ['a filters key holding nothing readable', { filters: {} }],
  ])('fails the step for %s instead of querying without a filter', async (_label, filters) => {
    await expect(run(filters)).rejects.toThrow();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('sends the resolved filter when the shape is readable', async () => {
    await run({ filters: [{ fieldName: 'event_id', operator: 'eq', value: 'demo' }] });

    expect(sendRequest).toHaveBeenCalledTimes(1);
    const url: string = sendRequest.mock.calls[0][0].url;
    expect(url).toContain('filters%5B0%5D%5BfieldId%5D=id_event_id');
    expect(url).toContain('filters%5B0%5D%5Boperator%5D=eq');
  });
});
