/// <reference types="vitest/globals" />

import { getHeapStatistics } from 'node:v8';
import { excelTestKit } from './excel-test-kit';
import { zipFixture, ZipFixtureEntry } from './zip-fixture';

const { convert, zipBase64 } = excelTestKit;

// Every test here would exhaust memory, or run for minutes, if the bound it checks regressed.
// vitest.config.ts caps the worker heap so such a regression fails fast instead of taking the
// runner down, and each test carries its own time limit.
const BOUNDED_TEST = { timeout: 15_000 };
// --max-old-space-size=512 plus the young generation; an uncapped worker gets several GB.
const MAX_WORKER_HEAP_BYTES = 1024 * 1024 * 1024;

const SPREADSHEET_MAIN_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

describe('excelToCsvAction resource bounds', () => {
  test('runs under a capped heap', () => {
    expect(getHeapStatistics().heap_size_limit).toBeLessThan(MAX_WORKER_HEAP_BYTES);
  });

  test('refuses a workbook whose parts decompress beyond the size cap', BOUNDED_TEST, async () => {
    const parts = zipFixture.minimalWorkbookParts({ sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>' });
    const base64 = zipBase64(
      parts.map((part) => (part.name === 'xl/worksheets/sheet1.xml' ? { ...part, declaredSize: 101 * 1024 * 1024 } : part))
    );
    await expect(convert({ base64 })).rejects.toThrow('The workbook is too large to convert');
  });

  test('refuses a part that decompresses to more than the size it declares', BOUNDED_TEST, async () => {
    const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${SPREADSHEET_MAIN_NS}><sheetData>${'<row/>'.repeat(200_000)}</sheetData></worksheet>`;
    const parts = zipFixture
      .minimalWorkbookParts({ sheetData: '' })
      .map((part) => (part.name === 'xl/worksheets/sheet1.xml' ? { name: part.name, data: sheetXml, declaredSize: 1000 } : part));
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('does not match the size it declares');
  });

  test('skips parts the conversion never reads, whatever they declare or hold', BOUNDED_TEST, async () => {
    const parts = [
      ...zipFixture.minimalWorkbookParts({ sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>' }),
      { name: 'xl/media/image1.png', data: 'not inflated', declaredSize: 500 * 1024 * 1024 },
      { name: 'xl/charts/chart1.xml', data: '<chartSpace/>' },
      { name: 'xl/comments1.xml', data: repeatedPart({ root: 'comments', unit: '<comment ref="A1" authorId="0"><text><t>x</t></text></comment>', count: 500_000 }) },
      { name: 'xl/tables/table1.xml', data: repeatedPart({ root: 'table', unit: '<tableColumn id="1" name="c"/>', count: 500_000 }) },
    ];
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test('refuses a sheet whose used range exceeds the cell budget', BOUNDED_TEST, async () => {
    const base64 = zipBase64(
      zipFixture.minimalWorkbookParts({
        sheetData: '<row r="1"><c r="A1"><v>1</v></c></row><row r="400"><c r="XFD400"><v>2</v></c></row>',
      })
    );
    await expect(convert({ base64 })).rejects.toThrow(
      'Sheet "Data" is too large to convert: its used range is 400 rows by 16384 columns'
    );
  });

  test('refuses a workbook whose sheets hold more cells and rows than the load budget, before loading it', BOUNDED_TEST, async () => {
    const emptyRow = `<row>${'<c/>'.repeat(1200)}</row>`;
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: emptyRow.repeat(1000) }));
    await expect(convert({ base64 })).rejects.toThrow('The workbook is too large to convert: it holds more than 1,200,000 cells\' worth');
  });

  test('counts cell and row elements with a namespace prefix towards the load budget', BOUNDED_TEST, async () => {
    const prefixedRow = `<x:row>${'<x:c/>'.repeat(1200)}</x:row>`;
    const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>${prefixedRow.repeat(1000)}</x:sheetData></x:worksheet>`;
    const parts = zipFixture
      .minimalWorkbookParts({ sheetData: '' })
      .map((part) => (part.name === 'xl/worksheets/sheet1.xml' ? { name: part.name, data: sheetXml } : part));
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('The workbook is too large to convert');
  });

  test('refuses a workbook whose shared strings exceed the load budget, before loading it', BOUNDED_TEST, async () => {
    const parts = withWorkbookPart({
      part: { name: 'xl/sharedStrings.xml', data: repeatedPart({ root: 'sst', unit: '<si/>', count: 4_900_000 }) },
      relationship: 'sharedStrings',
    });
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('The workbook is too large to convert');
  });

  test('refuses a workbook whose styles exceed the load budget, before loading it', BOUNDED_TEST, async () => {
    const parts = withWorkbookPart({
      part: { name: 'xl/styles.xml', data: repeatedPart({ root: 'styleSheet', unit: '<xf/>', count: 1_250_000 }) },
      relationship: 'styles',
    });
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('The workbook is too large to convert');
  });

  test('ignores defined names and merged ranges when converting', BOUNDED_TEST, async () => {
    const base64 = zipBase64(
      zipFixture.minimalWorkbookParts({
        sheetData: '<row r="1"><c r="A1" t="inlineStr"><is><t>top</t></is></c><c r="C1"><v>3</v></c></row>',
        sheetExtra: '<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A2:XFD1048576"/></mergeCells>',
        workbookExtra:
          '<definedNames>' +
          '<definedName name="everything">Data!$A$1:$XFD$1048576</definedName>' +
          '<definedName name="elsewhere">Other!$A$1:$XFD$1048576</definedName>' +
          '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$XFD$1048576</definedName>' +
          '</definedNames>',
      })
    );
    const result = await convert({ base64 });
    expect(result.available_sheets).toEqual(['Data']);
    expect(result.csv).toBe('top,,3');
  });
});

function repeatedPart({ root, unit, count }: { root: string; unit: string; count: number }): Uint8Array {
  return Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><${root} ${SPREADSHEET_MAIN_NS}>`),
    Buffer.alloc(unit.length * count, unit),
    Buffer.from(`</${root}>`),
  ]);
}

function withWorkbookPart({ part, relationship }: { part: ZipFixtureEntry; relationship: string }): ZipFixtureEntry[] {
  const relationshipXml = `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${relationship}" Target="${part.name.replace('xl/', '')}"/>`;
  return [
    ...zipFixture.minimalWorkbookParts({ sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>' }).map((entry) =>
      entry.name === 'xl/_rels/workbook.xml.rels' && typeof entry.data === 'string'
        ? { ...entry, data: entry.data.replace('</Relationships>', `${relationshipXml}</Relationships>`) }
        : entry
    ),
    part,
  ];
}
