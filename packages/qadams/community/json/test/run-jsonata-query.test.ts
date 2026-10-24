import { readFileSync } from 'fs';
import { tryCatch } from '@aiqadam/qadams-framework';
import { describe, expect, it, vi } from 'vitest';
import { runJsonataQuery } from '../src/lib/actions/run-jsonata-query';

type RunContext = Parameters<typeof runJsonataQuery.run>[0];

function contextWith({
  json,
  query,
  timeoutInSeconds,
}: {
  json: unknown;
  query: string;
  timeoutInSeconds?: number;
}): RunContext {
  return { propsValue: { json, query, timeoutInSeconds } } as unknown as RunContext;
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
      /JSONata Execution Failed.*check your query syntax/
    );
  });
});

/**
 * jsonata's resource guardrails (`timeout`, `stack`, `sequence`) are opt-in (#646): with no options
 * at all, a query the flow author got wrong, or one built from trigger data an outside sender
 * controls, can hold a sandbox slot until the worker's 600s kill timer fires. These cases pin that
 * the action always passes the guardrails, and that they stop a runaway expression within a second,
 * not within ten minutes.
 */
describe('run_jsonata_query guardrails against a runaway expression', () => {
  it('fails fast on a non-tail-recursive expression that never terminates', async () => {
    const start = Date.now();
    const { error } = await tryCatch(() =>
      runJsonataQuery.run(contextWith({ json: {}, query: '($f := function($x){$f($x+1)+0}; $f(0))' }))
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(error?.message).toMatch(/JSONata Execution Failed.*safety limit/);
  });

  it('bounds a tail-recursive infinite loop by the configured timeout, not the sandbox kill timer', async () => {
    const start = Date.now();
    const { error } = await tryCatch(() =>
      runJsonataQuery.run(
        contextWith({ json: {}, query: '($f := function($x){$f($x+1)}; $f(0))', timeoutInSeconds: 1 })
      )
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4000);
    expect(error?.message).toMatch(/JSONata Execution Failed.*safety limit.*Evaluation timeout/);
  });

  it('caps a user-set timeout at the conservative maximum rather than trusting it outright', async () => {
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      // The first call captures jsonata's own start timestamp; every call after that is a
      // guardrail check. Jumping it forward lets the test assert on the capped value without
      // waiting out an uncapped, flow-author-supplied duration in real time.
      return calls === 1 ? 0 : Number.MAX_SAFE_INTEGER;
    });
    try {
      const { error } = await tryCatch(() =>
        runJsonataQuery.run(contextWith({ json: {}, query: '$sum([1,2,3])', timeoutInSeconds: 999_999 }))
      );
      expect(error?.message).toMatch(/Evaluation timeout after 10000 milliseconds/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects a sequence that would grow past the conservative maximum instead of allocating it', async () => {
    const start = Date.now();
    const { error } = await tryCatch(() =>
      runJsonataQuery.run(contextWith({ json: {}, query: '[1..2000000]' }))
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(error?.message).toMatch(/safety limit.*maximum sequence length/i);
  });

  it('does not leak jsonata internal file paths from its guardrail errors', async () => {
    const { error } = await tryCatch(() =>
      runJsonataQuery.run(contextWith({ json: {}, query: '[1..2000000]' }))
    );
    expect(error?.message).not.toMatch(/node_modules|\.js:\d+:\d+/);
  });
});

const POLLUTION_MARKER = 'qadamPollutionMarker';

/**
 * The query is typed by the flow author, so it must not be able to hand back a live JavaScript function
 * (the first step of every code-execution chain in GHSA-8gq3-vp5j-2grp, GHSA-2943-5xfg-gq5f and
 * GHSA-66mm-25pp-rfff) or write to a shared prototype (GHSA-663r-x48j-fg8p). Each probe stops at
 * *reaching* the internal; none calls it. On jsonata 2.1.0 every probe in `REACH_ATTEMPTS` resolves to
 * a native function or object, so these cases fail there. The binding-override probe is what covers
 * GHSA-663r-x48j-fg8p's vector; the Object.prototype case below is a forward regression guard only,
 * since 2.1.0 already refuses those particular `__proto__` writes.
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
