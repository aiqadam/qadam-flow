import { readFileSync } from 'fs';
import { tryCatch } from '@aiqadam/shared';
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

const POLLUTION_MARKER = 'qadamPollutionMarker';

/**
 * The query is typed by the flow author, so it must not be able to hand back a live JavaScript function
 * (the first step of every code-execution chain in GHSA-8gq3-vp5j-2grp, GHSA-2943-5xfg-gq5f and
 * GHSA-66mm-25pp-rfff) or write to a shared prototype (GHSA-663r-x48j-fg8p). Each probe stops at
 * *reaching* the internal; none calls it. On jsonata 2.1.0 every probe in `REACH_ATTEMPTS` resolves to
 * a native function or object, so these cases fail there.
 */
describe('run_jsonata_query against expressions reaching for JavaScript internals', () => {
  const REACH_ATTEMPTS = [
    { label: 'an inherited constructor on the input', query: 'constructor' },
    { label: 'the input prototype', query: '__proto__' },
    { label: 'an inherited accessor helper', query: '__lookupSetter__' },
    { label: 'a prototype member via $lookup', query: '$lookup({}, "constructor")' },
    {
      label: 'the Function constructor via a $hasOwnProperty binding override',
      query: '($hasOwnProperty := $spread($string); $__proto__ := $constructor; $constructor)',
    },
    { label: 'the implementation of a built-in via a wildcard', query: '($merge.*)[1]' },
  ];

  it.each(REACH_ATTEMPTS)('does not expose $label', async ({ query }) => {
    const { data, error } = await tryCatch(() => runJsonataQuery.run(contextWith({ json: {}, query })));
    expect(typeof data).not.toBe('function');
    expect(error !== null || data === null).toBe(true);
  });

  it('rejects an object literal that spoofs an internal function flag', async () => {
    await expect(
      runJsonataQuery.run(contextWith({ json: {}, query: '{"_jsonata_lambda": true}' }))
    ).rejects.toThrow(/reserved for internal use/);
  });

  it('leaves Object.prototype untouched', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    const attempts = [
      `$ ~> | __proto__ | {"${POLLUTION_MARKER}": true} |`,
      `($__proto__ := {"${POLLUTION_MARKER}": true}; $${POLLUTION_MARKER})`,
      `($hasOwnProperty := $spread($string); $__proto__ := {"${POLLUTION_MARKER}": true}; {}.${POLLUTION_MARKER})`,
    ];

    await Promise.all(
      attempts.map((query) => tryCatch(() => runJsonataQuery.run(contextWith({ json: { a: 1 }, query }))))
    );

    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
    expect(POLLUTION_MARKER in {}).toBe(false);
  });
});
