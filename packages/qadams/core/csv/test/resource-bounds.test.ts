/// <reference types="vitest/globals" />

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { excelTestKit } from './excel-test-kit';
import { zipFixture, ZipFixtureEntry } from './zip-fixture';

const { convert, workbookLoader, zipBase64 } = excelTestKit;

// Every test here would exhaust memory, or run for minutes, if the bound it checks regressed.
// vitest.config.ts caps the worker heap so such a regression fails fast instead of taking the
// runner down, and each test carries its own time limit.
const BOUNDED_TEST = { timeout: 15_000 };
// The worker flags in vitest.config.ts put the limit near 536 MiB; without them it is several GB.
const MAX_WORKER_HEAP_BYTES = 600 * 1024 * 1024;
const MEBIBYTE = 1024 * 1024;

const SPREADSHEET_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SPREADSHEET_MAIN_NS = `xmlns="${SPREADSHEET_MAIN}"`;
const ONE_CELL = '<row r="1"><c r="A1"><v>1</v></c></row>';
const WHOLE_SHEET = 'Data!$A$1:$XFD$1048576';
const TOO_LARGE = 'The workbook is too large to convert';
const OVER_LOAD_BUDGET = 'need more memory than a conversion may use';

describe('excelToCsvAction resource bounds', () => {
  test('runs under a capped heap', () => {
    expect(getHeapStatistics().heap_size_limit).toBeLessThan(MAX_WORKER_HEAP_BYTES);
  });

  test('refuses a workbook whose parts decompress beyond the size cap', BOUNDED_TEST, async () => {
    const parts = zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL });
    const base64 = zipBase64(
      parts.map((part) => (part.name === 'xl/worksheets/sheet1.xml' ? { ...part, declaredSize: 101 * MEBIBYTE } : part))
    );
    await expect(convert({ base64 })).rejects.toThrow(TOO_LARGE);
  });

  test('refuses a part that decompresses to more than the size it declares', BOUNDED_TEST, async () => {
    const sheetXml = worksheetXml({ sheetData: '<row/>'.repeat(200_000) });
    const parts = replacePart({ parts: zipFixture.minimalWorkbookParts({ sheetData: '' }), part: { name: 'xl/worksheets/sheet1.xml', data: sheetXml, declaredSize: 1000 } });
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow('does not match the size it declares');
  });

  test('skips parts the conversion never reads, whatever they declare or hold', BOUNDED_TEST, async () => {
    const parts = [
      ...zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL }),
      { name: 'xl/media/image1.png', data: 'not inflated', declaredSize: 500 * MEBIBYTE },
      { name: 'xl/charts/chart1.xml', data: '<chartSpace/>' },
      { name: 'xl/comments1.xml', data: repeatedPart({ root: 'comments', unit: '<comment ref="A1" authorId="0"><text><t>x</t></text></comment>', count: 500_000 }) },
      { name: 'xl/tables/table1.xml', data: repeatedPart({ root: 'table', unit: '<tableColumn id="1" name="c"/>', count: 500_000 }) },
    ];
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test.each([
    ['comments', (payload: string) => `<!--${payload}-->`],
    ['CDATA sections', (payload: string) => `<extra><![CDATA[${payload}]]></extra>`],
    ['processing instructions', (payload: string) => `<?extra ${payload}?>`],
  ])('refuses %s beyond the size cap, before inflating them', BOUNDED_TEST, async (_label, wrap) => {
    const sheetExtra = wrap('a'.repeat(11 * MEBIBYTE));
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL, sheetExtra }));
    await expect(convert({ base64 })).rejects.toThrow(TOO_LARGE);
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

  test('lowers the used-range budget by what loading the workbook takes', BOUNDED_TEST, async () => {
    const sheetData = `${'<row/>'.repeat(400_000)}<row r="400001"><c r="A400001"><v>1</v></c></row><row r="400300"><c r="XFD400300"><v>2</v></c></row>`;
    const outcome = convert({ base64: zipBase64(zipFixture.minimalWorkbookParts({ sheetData })) });
    await expect(outcome).rejects.toThrow('its used range is 300 rows by 16384 columns, more than the');
    const message = await outcome.catch((error: Error) => error.message);
    const allowed = Number(/more than the ([\d,]+) cells/.exec(message)?.[1].replace(/,/g, ''));
    expect(allowed).toBeLessThan(300 * 16384);
  });

  test('refuses a workbook whose sheets hold more cells and rows than the load budget, before loading it', BOUNDED_TEST, async () => {
    const emptyRow = `<row>${'<c/>'.repeat(1200)}</row>`;
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: emptyRow.repeat(1000) }));
    await expect(convert({ base64 })).rejects.toThrow(OVER_LOAD_BUDGET);
  });

  test('counts cell and row elements with a namespace prefix towards the load budget', BOUNDED_TEST, async () => {
    const prefixedRow = `<x:row>${'<x:c/>'.repeat(1200)}</x:row>`;
    const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${SPREADSHEET_MAIN}"><x:sheetData>${prefixedRow.repeat(1000)}</x:sheetData></x:worksheet>`;
    const parts = replacePart({ parts: zipFixture.minimalWorkbookParts({ sheetData: '' }), part: { name: 'xl/worksheets/sheet1.xml', data: sheetXml } });
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow(OVER_LOAD_BUDGET);
  });

  test('counts every element start towards the load budget, however its name is delimited', BOUNDED_TEST, async () => {
    const row = `<row>${'<\u000bc/><c\f/>'.repeat(600)}</row>`;
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: row.repeat(1000) }));
    await expect(convert({ base64 })).rejects.toThrow(OVER_LOAD_BUDGET);
  });

  test.each([
    ['shared strings', { name: 'xl/sharedStrings.xml', root: 'sst', unit: '<si/>', count: 1_500_000, relationship: 'sharedStrings' }],
    ['styles', { name: 'xl/styles.xml', root: 'styleSheet', unit: '<xf/>', count: 1_250_000, relationship: 'styles' }],
  ])('refuses a workbook whose %s exceed the load budget, before loading it', BOUNDED_TEST, async (_label, { name, root, unit, count, relationship }) => {
    const parts = withWorkbookPart({ part: { name, data: repeatedPart({ root, unit, count }) }, relationship });
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow(OVER_LOAD_BUDGET);
  });

  test('refuses a workbook whose relationships exceed the load budget, before loading it', BOUNDED_TEST, async () => {
    const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>${'<Relationship/>'.repeat(600_000)}</Relationships>`;
    const parts = replacePart({ parts: zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL }), part: { name: 'xl/_rels/workbook.xml.rels', data: relationships } });
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow(OVER_LOAD_BUDGET);
  });

  test.each([
    ['page breaks', `<colBreaks>${'<brk/>'.repeat(1_200_000)}</colBreaks>`],
    ['ignored errors', `<ignoredErrors>${'<ignoredError/>'.repeat(600_000)}</ignoredErrors>`],
  ])('refuses a sheet whose %s exceed the load budget, before loading it', BOUNDED_TEST, async (_label, sheetExtra) => {
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL, sheetExtra }));
    await expect(convert({ base64 })).rejects.toThrow(OVER_LOAD_BUDGET);
  });

  test('ignores defined names, merged ranges and other worksheet nodes the CSV does not use', BOUNDED_TEST, async () => {
    const base64 = zipBase64(
      zipFixture.minimalWorkbookParts({
        sheetData: '<row r="1"><c r="A1" t="inlineStr"><is><t>top</t></is></c><c r="C1"><v>3</v></c></row>',
        sheetExtra:
          '<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A2:XFD1048576"/></mergeCells>' +
          '<colBreaks count="1"><brk id="16383" max="1048575" man="1"/></colBreaks>' +
          '<ignoredErrors><ignoredError sqref="A1:XFD1048576" numberStoredAsText="1"/></ignoredErrors>',
        workbookExtra:
          '<definedNames>' +
          `<definedName name="everything">${WHOLE_SHEET}</definedName>` +
          '<definedName name="elsewhere">Other!$A$1:$XFD$1048576</definedName>' +
          `<definedName name="_xlnm.Print_Area" localSheetId="0">${WHOLE_SHEET}</definedName>` +
          '</definedNames>',
      })
    );
    const result = await convert({ base64 });
    expect(result.available_sheets).toEqual(['Data']);
    expect(result.csv).toBe('top,,3');
  });

  test('ignores defined names under a namespace prefix of any characters', BOUNDED_TEST, async () => {
    const workbookXml =
      `<?xml version="1.0" encoding="UTF-8"?><é:workbook xmlns:é="${SPREADSHEET_MAIN}" xmlns:r="${RELATIONSHIPS}">` +
      '<é:sheets><é:sheet name="Data" sheetId="1" r:id="rId1"/></é:sheets>' +
      `<é:definedNames><é:definedName name="everything">${WHOLE_SHEET}</é:definedName></é:definedNames></é:workbook>`;
    const parts = replacePart({ parts: zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL }), part: { name: 'xl/workbook.xml', data: workbookXml } });
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('1');
  });

  test('skips every worksheet node the parser maps except cell data', BOUNDED_TEST, async () => {
    const loader = workbookLoader();
    const loadSpy = vi.spyOn(loader, 'loadFromFiles');
    try {
      await convert({ base64: zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL })) });
      const options: unknown = loadSpy.mock.calls[0]?.[1];
      const ignoreNodes = typeof options === 'object' && options !== null && 'ignoreNodes' in options ? options.ignoreNodes : undefined;
      expect([...(Array.isArray(ignoreNodes) ? ignoreNodes : [])].sort()).toEqual(parserWorksheetNodes().filter((node) => node !== 'sheetData').sort());
    }
    finally {
      loadSpy.mockRestore();
    }
  });

  test.each([
    ['xl/workbook.xml'],
    ['xl/worksheets/sheet1.xml'],
  ])('refuses a workbook whose %s is not valid UTF-8', BOUNDED_TEST, async (name) => {
    const parts = zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL }).map((part) =>
      part.name === name && typeof part.data === 'string'
        ? { ...part, data: Buffer.concat([Buffer.from(part.data.replace(/<\/(\w+)>$/, '')), Buffer.from([0xff]), Buffer.from(part.data.slice(part.data.lastIndexOf('</')))]) }
        : part
    );
    await expect(convert({ base64: zipBase64(parts) })).rejects.toThrow(`${name} is not valid UTF-8 text`);
  });

  test.each([
    ['a control character', '<defined\u0001Names><definedName name="everything">Data!$A$1:$A$2</definedName></defined\u0001Names>'],
    ['a non-character', '<sheetPr codeName="￾"/>'],
  ])('refuses a workbook.xml holding %s, which the parser would drop silently', BOUNDED_TEST, async (_label, workbookExtra) => {
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL, workbookExtra }));
    await expect(convert({ base64 })).rejects.toThrow('xl/workbook.xml contains characters that XML does not allow');
  });

  test('refuses a workbook.xml in which defined names can still be found after they are skipped', BOUNDED_TEST, async () => {
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL, workbookExtra: '<extLst><ext uri="x:definedNames"/></extLst>' }));
    await expect(convert({ base64 })).rejects.toThrow('xl/workbook.xml contains defined names in a form this action cannot skip');
  });
});

function worksheetXml({ sheetData }: { sheetData: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet ${SPREADSHEET_MAIN_NS}><sheetData>${sheetData}</sheetData></worksheet>`;
}

function repeatedPart({ root, unit, count }: { root: string; unit: string; count: number }): Uint8Array {
  return Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><${root} ${SPREADSHEET_MAIN_NS}>`),
    Buffer.alloc(unit.length * count, unit),
    Buffer.from(`</${root}>`),
  ]);
}

function replacePart({ parts, part }: { parts: ZipFixtureEntry[]; part: ZipFixtureEntry }): ZipFixtureEntry[] {
  return parts.map((entry) => (entry.name === part.name ? part : entry));
}

function withWorkbookPart({ part, relationship }: { part: ZipFixtureEntry; relationship: string }): ZipFixtureEntry[] {
  const relationshipXml = `<Relationship Id="rId9" Type="${RELATIONSHIPS}/${relationship}" Target="${part.name.replace('xl/', '')}"/>`;
  return [
    ...zipFixture.minimalWorkbookParts({ sheetData: ONE_CELL }).map((entry) =>
      entry.name === 'xl/_rels/workbook.xml.rels' && typeof entry.data === 'string'
        ? { ...entry, data: entry.data.replace('</Relationships>', `${relationshipXml}</Relationships>`) }
        : entry
    ),
    part,
  ];
}

// The worksheet nodes the parser maps to a reader of its own, read from its worksheet reader
// so the test notices a node a new parser version adds.
function parserWorksheetNodes(): string[] {
  const packageDir = path.dirname(require.resolve('@cj-tech-master/excelts/package.json'));
  const source = readFileSync(path.join(packageDir, 'dist/cjs/modules/excel/xlsx/xform/sheet/worksheet-xform.js'), 'utf8');
  const mapBody = /this\.map = \{([\s\S]*?)\n {8}\};/.exec(source)?.[1] ?? '';
  return [...mapBody.matchAll(/^ {12}(\w+): /gm)].map((match) => match[1]);
}
