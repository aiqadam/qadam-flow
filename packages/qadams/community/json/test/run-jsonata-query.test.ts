import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { runJsonataQuery } from '../src/lib/actions/run-jsonata-query';

type RunContext = Parameters<typeof runJsonataQuery.run>[0];

function contextWith({ json, query }: { json: unknown; query: string }): RunContext {
  return { propsValue: { json, query } } as unknown as RunContext;
}

function installedJsonataVersion(): string {
  const manifestPath = require.resolve('jsonata/package.json');
  const manifest: { version: string } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return manifest.version;
}

const ORDERS = {
  orders: [
    { id: 1, status: 'active', total: 10 },
    { id: 2, status: 'closed', total: 5 },
    { id: 3, status: 'active', total: 7 },
  ],
};

/**
 * Pins the behaviour flows rely on across the jsonata 2.1 -> 2.2 upgrade (#615). 2.2.0/2.2.1 closed
 * several advisories against user-typed expressions; these cases guard that ordinary queries keep
 * producing the same results, and that the patched release is the one actually resolved.
 */
describe('run_jsonata_query', () => {
  it('resolves a jsonata release at or above 2.2.1', () => {
    const [major, minor, patch] = installedJsonataVersion().split('.').map(Number);
    expect(major).toBe(2);
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(2001);
  });

  it('filters and maps an array', async () => {
    const result = await runJsonataQuery.run(
      contextWith({ json: ORDERS, query: 'orders[status="active"].id' })
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual([1, 3]);
  });

  it('aggregates values', async () => {
    const result = await runJsonataQuery.run(contextWith({ json: ORDERS, query: '$sum(orders.total)' }));
    expect(result).toBe(22);
  });

  it('accepts JSON passed as a string', async () => {
    const result = await runJsonataQuery.run(
      contextWith({ json: JSON.stringify(ORDERS), query: '$count(orders)' })
    );
    expect(result).toBe(3);
  });

  it('returns null when nothing matches', async () => {
    const result = await runJsonataQuery.run(
      contextWith({ json: ORDERS, query: 'orders[status="missing"]' })
    );
    expect(result).toBeNull();
  });

  it('wraps a syntax error', async () => {
    await expect(runJsonataQuery.run(contextWith({ json: ORDERS, query: 'orders[' }))).rejects.toThrow(
      /JSONata Execution Failed/
    );
  });
});
