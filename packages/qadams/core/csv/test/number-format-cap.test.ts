/// <reference types="vitest/globals" />

import { excelTestKit } from './excel-test-kit';

const { buildWorkbookBase64, convert } = excelTestKit;

// Its own file: the process-wide set of admitted formats lives as long as the module, and once
// this test fills it, every later test in the same file would see new formats rendered as
// General.
const FORMATS_PER_WORKBOOK = 512;
const PROCESS_FORMAT_CAP = 4096;

describe('excelToCsvAction number format cache', () => {
  test('stops admitting new number formats once the process has seen 4096, and keeps rendering the ones it has', { timeout: 60_000 }, async () => {
    const workbooksToFillCap = PROCESS_FORMAT_CAP / FORMATS_PER_WORKBOOK;
    const filling = await Promise.all(
      Array.from({ length: workbooksToFillCap }, (_, workbookIndex) => workbookWithDistinctFormats(`w${workbookIndex}`))
    );
    for (const base64 of filling) {
      const lines = (await convert({ base64 })).csv.split('\n');
      expect(lines.every((line) => line.startsWith('1.5#'))).toBe(true);
    }

    const beyondCap = (await convert({ base64: await workbookWithDistinctFormats('late') })).csv.split('\n');
    expect(beyondCap).toEqual(Array.from({ length: FORMATS_PER_WORKBOOK }, () => '1.5'));

    const admittedEarlier = (await convert({ base64: filling[0] })).csv.split('\n');
    expect(admittedEarlier[0]).toBe('1.5#w0-1');
  });
});

async function workbookWithDistinctFormats(tag: string): Promise<string> {
  return buildWorkbookBase64((workbook) => {
    const sheet = workbook.addWorksheet('Formats');
    for (let row = 1; row <= FORMATS_PER_WORKBOOK; row++) {
      sheet.getCell(row, 1).value = 1.5;
      sheet.getCell(row, 1).numFmt = `0.0"#${tag}-${row}"`;
    }
  });
}
