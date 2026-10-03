/// <reference types="vitest/globals" />

import path from 'node:path';
import { conversionProtocol } from '../src/lib/common/conversion-protocol';
import { conversionWorker } from '../src/lib/common/conversion-worker';
import { excelTestKit } from './excel-test-kit';
import { zipFixture } from './zip-fixture';

const { convert, workbookLoader, workbookParts, zipBase64 } = excelTestKit;

// The worker inherits the test process's heap cap (vitest.config.ts), so a worker that runs
// away is stopped near 536 MiB at the latest.
const BOUNDED_TEST = { timeout: 60_000 };
const ONE_CELL = '<row r="1"><c r="A1"><v>1</v></c></row>';
const MAX_CALLER_HEAP_USED_BYTES = 300 * 1024 * 1024;

describe('conversionWorker', () => {
  test('stops the worker once its heap passes the limit it is given, below the process heap limit', BOUNDED_TEST, async () => {
    // 600,000 valued cells take about 200 MB to convert: within the process limit, over this one.
    const outcome = conversionWorker.run({ request: requestFor(valuedCells({ perRow: 1000, count: 600 })), limits: { heapLimitMb: 96, timeLimitMs: 60_000 } });
    await expect(outcome).rejects.toThrow('The workbook is too large to convert: converting it needs more than the 96 MB of memory a conversion may use');
    await expectCallerStillConverts();
  });

  test('starts the worker with the heap limit it is given', BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(ONE_CELL), limits: { heapLimitMb: 96, timeLimitMs: 60_000 }, entry: workerEntry('reports-resource-limits.cjs') });
    await expect(outcome).rejects.toThrow('"maxOldGenerationSizeMb":96');
  });

  test('reports a worker that reaches the process heap limit as too large',BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(ONE_CELL, `<!--${'a'.repeat(40 * 1024 * 1024)}-->`), limits: { heapLimitMb: 4096, timeLimitMs: 60_000 } });
    await expect(outcome).rejects.toThrow('The workbook is too large to convert: converting it needs more than the 4096 MB of memory a conversion may use');
    await expectCallerStillConverts();
  });

  test('stops a conversion that runs past its time limit', BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(valuedCells({ perRow: 1000, count: 200 })), limits: { heapLimitMb: 512, timeLimitMs: 100 } });
    await expect(outcome).rejects.toThrow('The workbook is too complex to convert: converting it takes longer than the 0.1 seconds a conversion may take');
    await expectCallerStillConverts();
  });

  test('reports a worker that ends without replying as too large or too complex', BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(ONE_CELL), entry: workerEntry('exits-early.cjs') });
    await expect(outcome).rejects.toThrow('The workbook is too large or too complex to convert: the conversion stopped before it finished');
    await expectCallerStillConverts();
  });

  test('refuses a reply that does not have the shape of a converted sheet', BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(ONE_CELL), entry: workerEntry('unexpected-reply.cjs') });
    await expect(outcome).rejects.toThrow('the conversion returned a result this action does not understand');
  });

  test('fails a conversion during which the parser modified a built-in prototype', BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(ONE_CELL), entry: workerEntry('parser-modifies-prototype.cjs') });
    await expect(outcome).rejects.toThrow('A built-in prototype was modified while reading the file (Object.prototype[addedByParser])');
  });

  test('words an engine limit a conversion reaches as a workbook too large or too complex, and passes other failures through', () => {
    expect(conversionProtocol.failureMessage(new RangeError('Invalid string length'))).toBe(
      'The workbook is too large or too complex to convert: Invalid string length. Delete unused rows, columns and sheets, or split the workbook, and try again.'
    );
    expect(conversionProtocol.failureMessage(new Error('Sheet "Other" not found. Available sheets: Data'))).toBe('Sheet "Other" not found. Available sheets: Data');
  });

  test('reports a worker that cannot start', BOUNDED_TEST, async () => {
    const outcome = conversionWorker.run({ request: requestFor(ONE_CELL), entry: workerEntry('missing.cjs') });
    await expect(outcome).rejects.toThrow('The workbook could not be converted: Cannot find module');
  });

  test('moves parts that own their buffer to the worker instead of copying them', BOUNDED_TEST, async () => {
    const parts = workbookParts(zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL })));
    const sheet = new Uint8Array(parts['xl/worksheets/sheet1.xml']);
    const result = await conversionWorker.run({ request: { parts: { ...parts, 'xl/worksheets/sheet1.xml': sheet }, sheetName: undefined, delimiter: ',' } });
    expect(result.csv).toBe('1');
    expect(sheet.byteLength).toBe(0);
  });

  test('the action loads the workbook only in its worker, never in the calling thread', BOUNDED_TEST, async () => {
    const loadSpy = vi.spyOn(workbookLoader(), 'loadFromFiles');
    try {
      const result = await convert({ base64: zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL })) });
      expect(result.csv).toBe('1');
      expect(loadSpy).not.toHaveBeenCalled();
    }
    finally {
      loadSpy.mockRestore();
    }
  });
});

function requestFor(sheetData: string, sheetExtra?: string) {
  return { parts: workbookParts(zipBase64(zipFixture.minimalWorkbookParts({ sheetData, sheetExtra }))), sheetName: undefined, delimiter: ',' };
}

function valuedCells({ perRow, count }: { perRow: number; count: number }): string {
  return `<row>${'<c><v>1</v></c>'.repeat(perRow)}</row>`.repeat(count);
}

function workerEntry(name: string): string {
  return path.join(__dirname, 'worker-entries', name);
}

async function expectCallerStillConverts(): Promise<void> {
  const result = await convert({ base64: zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL })) });
  expect(result.csv).toBe('1');
  expect(process.memoryUsage().heapUsed).toBeLessThan(MAX_CALLER_HEAP_USED_BYTES);
}
