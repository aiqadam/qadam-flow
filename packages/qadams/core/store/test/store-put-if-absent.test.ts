import { StoreScope } from '@aiqadam/qadams-framework';
import { describe, expect, it, vi } from 'vitest';
import { storagePutIfAbsentAction } from '../src/lib/actions/store-put-if-absent';
import { PieceStoreScope } from '../src/lib/actions/common';

type PutIfAbsentCall = { key: string; value: unknown; scope: StoreScope | undefined; options: { ttlSeconds?: number } | undefined };

function context({ propsValue, runId = 'run-1' }: { propsValue: Record<string, unknown>; runId?: string }) {
  const calls: PutIfAbsentCall[] = [];
  const ctx = {
    propsValue,
    run: { id: runId },
    store: {
      putIfAbsent: async (key: string, value: unknown, scope: StoreScope | undefined, options: { ttlSeconds?: number } | undefined) => {
        calls.push({ key, value, scope, options });
        return { stored: true, value };
      },
    },
  } as unknown as Parameters<typeof storagePutIfAbsentAction.run>[0];
  return { ctx, calls };
}

describe('store put_if_absent', () => {
  it('is registered on the qadam', async () => {
    const { storage } = await import('../src/index');
    expect(Object.keys(storage.actions())).toContain('put_if_absent');
  });

  it('passes the value through and reports whether this run stored it', async () => {
    const { ctx, calls } = context({ propsValue: { key: 'k', value: 'v', store_scope: PieceStoreScope.PROJECT } });

    const result = await storagePutIfAbsentAction.run(ctx);

    expect(result).toEqual({ stored: true, value: 'v' });
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('k');
    expect(calls[0].scope).toBe(StoreScope.PROJECT);
  });

  // A TTL of "not set" must stay absent rather than become 0 or null — the server
  // reads absent as "keeps forever".
  it('sends no ttl when the field is empty, and the exact ttl when it is set', async () => {
    const { ctx: withoutTtl, calls: withoutTtlCalls } = context({ propsValue: { key: 'k', value: 'v', store_scope: PieceStoreScope.PROJECT } });
    await storagePutIfAbsentAction.run(withoutTtl);
    expect(withoutTtlCalls[0].options).toBeUndefined();

    const { ctx: withTtl, calls: withTtlCalls } = context({ propsValue: { key: 'k', value: 'v', store_scope: PieceStoreScope.PROJECT, ttl_seconds: 90 } });
    await storagePutIfAbsentAction.run(withTtl);
    expect(withTtlCalls[0].options).toEqual({ ttlSeconds: 90 });
  });

  it('scopes the key the same way the other store actions do', async () => {
    const { ctx: flow, calls: flowCalls } = context({ propsValue: { key: 'k', value: 'v', store_scope: PieceStoreScope.FLOW } });
    await storagePutIfAbsentAction.run(flow);
    expect(flowCalls[0]).toMatchObject({ key: 'k', scope: StoreScope.FLOW });

    const { ctx: run, calls: runCalls } = context({ propsValue: { key: 'k', value: 'v', store_scope: PieceStoreScope.RUN }, runId: 'run-42' });
    await storagePutIfAbsentAction.run(run);
    // RUN scope is FLOW scope with a per-run prefix; losing the prefix would make a
    // dedup key collide across every run of the flow.
    expect(runCalls[0]).toMatchObject({ key: 'run_run-42/k', scope: StoreScope.FLOW });
  });

  it('rejects a key longer than the column allows', async () => {
    const { ctx } = context({ propsValue: { key: 'x'.repeat(129), value: 'v', store_scope: PieceStoreScope.PROJECT } });

    await expect(storagePutIfAbsentAction.run(ctx)).rejects.toThrow();
  });
});
