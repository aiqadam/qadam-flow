/// <reference types="vitest/globals" />

import { xlsxArchive, XlsxArchiveError } from '../src/lib/common/xlsx-archive';
import { excelTestKit } from './excel-test-kit';
import { zipFixture, ZipFixtureEntry } from './zip-fixture';

const { convert, zipBase64 } = excelTestKit;

const SHEET_DATA = '<row r="1"><c r="A1"><v>1</v></c></row>';

describe('xlsxArchive', () => {
  test('reads parts whose sizes are stored in a ZIP64 extra field', async () => {
    const parts = workbookParts().map((part) => ({ ...part, zip64: true }));
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test('reads parts whose sizes follow the data in a data descriptor', async () => {
    const parts = workbookParts().map((part) => ({ ...part, dataDescriptor: true }));
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test('reads parts stored without compression', async () => {
    const parts = workbookParts().map((part) => ({ ...part, compress: false }));
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test('reads an archive whose part names use backslashes or a leading slash', async () => {
    const parts = workbookParts().map((part, index) => ({
      ...part,
      name: index % 2 === 0 ? part.name.replace(/\//g, '\\') : `/${part.name}`,
    }));
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test('refuses an archive that lists the same part twice, including under another spelling of its name', () => {
    const spellings = ['xl/workbook.xml', 'xl\\workbook.xml', '/xl/workbook.xml'];
    spellings.forEach((duplicateName) => {
      const parts = [...workbookParts(), { name: duplicateName, data: '<workbook/>' }];
      expect(() => extract(parts)).toThrow('the archive lists the same part more than once');
    });
  });

  test('refuses encrypted parts with the protected-workbook message', async () => {
    const parts = workbookParts().map((part) => ({ ...part, flags: 0x1 }));
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('password-protected workbook');
  });

  test('refuses parts compressed with a method other than stored or deflate', async () => {
    const parts = workbookParts().map((part) => (part.name === 'xl/workbook.xml' ? { ...part, method: 12 } : part));
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('uses unsupported compression method 12');
  });

  test('refuses a truncated archive', async () => {
    const whole = zipFixture.build(workbookParts());
    const withoutEnd = whole.subarray(0, whole.length - 10);
    const withoutData = Buffer.concat([whole.subarray(0, 40), whole.subarray(whole.length - 22)]);

    expect(() => xlsxArchive.extractEntries({ buffer: withoutEnd, maxUncompressedBytes: Infinity, skipPart: () => false })).toThrow(
      'the ZIP end-of-directory record is missing'
    );
    expect(() => xlsxArchive.extractEntries({ buffer: withoutData, maxUncompressedBytes: Infinity, skipPart: () => false })).toThrow(
      'the archive is truncated'
    );
    await expect(convert({ base64: withoutData.toString('base64') })).rejects.toThrow(
      'The file could not be read as an Excel workbook (.xlsx): the archive is truncated'
    );
  });

  test('reports the reason as an archive error', () => {
    const parts = workbookParts().map((part) => ({ ...part, flags: 0x1 }));
    expect(() => extract(parts)).toThrow(XlsxArchiveError);
  });
});

function workbookParts(): ZipFixtureEntry[] {
  return zipFixture.minimalWorkbookParts({ sheetData: SHEET_DATA });
}

function extract(parts: ZipFixtureEntry[]): Record<string, Uint8Array> {
  return xlsxArchive.extractEntries({ buffer: zipFixture.build(parts), maxUncompressedBytes: Infinity, skipPart: () => false });
}
