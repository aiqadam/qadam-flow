import { Field, FieldType, SYNTHETIC_FLOW_RUN_IDS } from '@aiqadam/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aiqadam/qadams-common')>();
  return { ...actual, httpClient: { sendRequest } };
});

const fields: Field[] = [{
  id: 'id_phone',
  created: '2026-09-01T00:00:00.000Z',
  updated: '2026-09-01T00:00:00.000Z',
  name: 'phone',
  externalId: 'phone',
  type: FieldType.TEXT,
  tableId: 'table_1',
  projectId: 'project_1',
}];

function context(runId?: string, projectId = 'project_1') {
  return {
    server: { apiUrl: 'https://example.invalid/api/', token: 'token' },
    project: { id: projectId },
    ...(runId ? { run: { id: runId } } : {}),
  };
}

// Every test re-imports the module to start from a cold cache, and the first of those imports pays
// the transform cost of the qadam and its dependencies — over the 5 s default on a CI runner, where
// it timed out and then leaked its in-flight request into the next test's spy count.
vi.setConfig({ testTimeout: 30_000 });

async function loadCommon() {
  vi.resetModules();
  return import('../src/lib/common');
}

describe('tables metadata cache', () => {
  beforeEach(() => {
    sendRequest.mockReset();
  });

  it('resolves the field schema once per run', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    const first = await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') });
    const second = await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') });

    expect(sendRequest).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('resolves the table id once per run', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: { data: [{ id: 'table_1' }] } });

    await tablesCommon.convertTableExternalIdToId('events', context('run_1'));
    const second = await tablesCommon.convertTableExternalIdToId('events', context('run_1'));

    expect(sendRequest).toHaveBeenCalledOnce();
    expect(second).toBe('table_1');
  });

  it('concurrent lookups in one run share a single request', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await Promise.all([
      tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') }),
      tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') }),
    ]);

    expect(sendRequest).toHaveBeenCalledOnce();
  });

  // A schema edited between runs has to be visible to the next one, so the cache must not
  // outlive the run it was filled for.
  it('re-reads the schema for a different run', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') });
    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_2') });

    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('does not cache outside a run, where property builders call it', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context() });
    await tablesCommon.getTableFields({ tableId: 'table_1', context: context() });

    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  // A transient failure must not be inherited by every later step of the same run.
  it('does not remember a failed lookup', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ body: fields });

    await expect(tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') })).rejects.toThrow('connect ECONNREFUSED');

    expect(await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') })).toEqual(fields);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  // The engine hands out one fixed `flowRunId` for every execution that is not a flow run, so an
  // entry made under it is shared by every project on the deployment and is never evicted by a
  // newer run — a schema edit would stay invisible for as long as the process lives.
  it.each(SYNTHETIC_FLOW_RUN_IDS)('does not cache under the synthetic run id %s', async (runId) => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context(runId) });
    await tablesCommon.getTableFields({ tableId: 'table_1', context: context(runId) });

    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  // A run id is not a tenant boundary on its own; the bucket has to be keyed by project too.
  it('does not share a cache entry between two projects under one run id', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1', 'project_1') });
    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1', 'project_2') });

    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  // The engine process outlives the runs, so the bucket count has to stay bounded. Evicting the
  // oldest is the price; growing without limit is not an option.
  it('evicts the oldest run once the bound is passed', async () => {
    const { tablesCommon, RUN_METADATA_CACHE_MAX_RUNS } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_oldest') });
    for (let i = 0; i < RUN_METADATA_CACHE_MAX_RUNS; i++) {
      await tablesCommon.getTableFields({ tableId: 'table_1', context: context(`run_${i}`) });
    }
    const requestsBefore = sendRequest.mock.calls.length;

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_oldest') });

    expect(sendRequest.mock.calls.length).toBe(requestsBefore + 1);
  });

  it('keeps two tables in the same run apart', async () => {
    const { tablesCommon } = await loadCommon();
    sendRequest.mockResolvedValue({ body: fields });

    await tablesCommon.getTableFields({ tableId: 'table_1', context: context('run_1') });
    await tablesCommon.getTableFields({ tableId: 'table_2', context: context('run_1') });

    expect(sendRequest).toHaveBeenCalledTimes(2);
  });
});
