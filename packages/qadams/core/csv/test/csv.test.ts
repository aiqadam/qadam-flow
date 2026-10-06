/// <reference types="vitest/globals" />

import { CellValue } from '@cj-tech-master/excelts';
import { csvToJsonAction } from '../src/lib/actions/convert-csv-to-json';
import { jsonToCsvAction } from '../src/lib/actions/convert-json-to-csv';
import { createMockActionContext } from '@aiqadam/qadams-framework';
import { excelTestKit } from './excel-test-kit';
import { SHEETJS_WRITTEN_WORKBOOK_BASE64 } from './sheetjs-written-workbook';
import { zipFixture } from './zip-fixture';

const { buildWorkbookBase64, zipBase64, readParts, builtInPrototypeKeys, convert } = excelTestKit;

async function makeXlsxBase64(sheets: Record<string, (string | number)[][]>): Promise<string> {
  return buildWorkbookBase64((workbook) => {
    for (const [name, rows] of Object.entries(sheets)) {
      workbook.addWorksheet(name).addRows(rows);
    }
  });
}

describe('csvToJsonAction', () => {
  test('converts CSV with headers to JSON', async () => {
    const csvText = 'name,age\nAlice,30\nBob,25';
    const ctx = createMockActionContext({
      propsValue: { csv_text: csvText, has_headers: true, delimiter_type: ',' },
    });
    const result = await csvToJsonAction.run(ctx);
    expect(result).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  test('converts CSV without headers to JSON arrays', async () => {
    const csvText = 'Alice,30\nBob,25';
    const ctx = createMockActionContext({
      propsValue: { csv_text: csvText, has_headers: false, delimiter_type: ',' },
    });
    const result = await csvToJsonAction.run(ctx);
    expect(result).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  test('handles tab delimiter', async () => {
    const csvText = 'name\tage\nAlice\t30';
    const ctx = createMockActionContext({
      propsValue: { csv_text: csvText, has_headers: true, delimiter_type: '\t' },
    });
    const result = await csvToJsonAction.run(ctx);
    expect(result).toEqual([{ name: 'Alice', age: '30' }]);
  });

  test('handles quoted fields with commas', async () => {
    const csvText = 'name,address\nAlice,"123 Main St, Apt 4"';
    const ctx = createMockActionContext({
      propsValue: { csv_text: csvText, has_headers: true, delimiter_type: ',' },
    });
    const result = await csvToJsonAction.run(ctx);
    expect(result).toEqual([
      { name: 'Alice', address: '123 Main St, Apt 4' },
    ]);
  });

  test('falls back to comma when a step persisted from before defaultValue was fixed still carries an empty delimiter_type', async () => {
    const csvText = 'name,age\nAlice,30';
    const ctx = createMockActionContext({
      propsValue: { csv_text: csvText, has_headers: true, delimiter_type: '' as unknown as ',' | '\t' },
    });
    const result = await csvToJsonAction.run(ctx);
    expect(result).toEqual([{ name: 'Alice', age: '30' }]);
  });

  test('throws error if input is not a string', async () => {
    const ctx = createMockActionContext({
      propsValue: { csv_text: 123 as unknown as string, has_headers: true, delimiter_type: ',' },
    });
    await expect(csvToJsonAction.run(ctx)).rejects.toThrow();
  });
});

describe('jsonToCsvAction', () => {
  test('converts JSON array to CSV', async () => {
    const jsonArray = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ];
    const ctx = createMockActionContext({
      propsValue: { markdown: '', json_array: jsonArray, delimiter_type: ',' },
    });
    const result = await jsonToCsvAction.run(ctx);
    expect(result).toContain('name');
    expect(result).toContain('age');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  test('flattens nested objects', async () => {
    const jsonArray = [
      { name: 'Alice', address: { street: '123 Main', city: 'LA' } },
    ];
    const ctx = createMockActionContext({
      propsValue: { markdown: '', json_array: jsonArray, delimiter_type: ',' },
    });
    const result = await jsonToCsvAction.run(ctx);
    expect(result).toContain('address.street');
    expect(result).toContain('address.city');
    expect(result).toContain('123 Main');
    expect(result).toContain('LA');
  });

  test('handles tab delimiter', async () => {
    const jsonArray = [{ name: 'Alice', age: 30 }];
    const ctx = createMockActionContext({
      propsValue: { markdown: '', json_array: jsonArray, delimiter_type: '\t' },
    });
    const result = await jsonToCsvAction.run(ctx);
    expect(result).toContain('\t');
  });

  test('throws error if input is not an array', async () => {
    const ctx = createMockActionContext({
      propsValue: { markdown: '', json_array: { not: 'an array' } as unknown as unknown[], delimiter_type: ',' },
    });
    await expect(jsonToCsvAction.run(ctx)).rejects.toThrow();
  });
});


// Every test here starts a conversion worker, loaded from TypeScript through tsx, and the tests
// that use the action pay that cost per conversion. On a contended CI runner one conversion has
// been measured at 2.7-4.0s (#697), so the 5s default leaves little room, and the one test that
// converts twice in sequence ("quotes fields...") crossed it. The timeout is per suite because
// every conversion test shares the cost, not only the one that failed first.
describe('excelToCsvAction', { timeout: 15_000 }, () => {
  test('converts first sheet to CSV with comma delimiter', async () => {
    const base64 = await makeXlsxBase64({ Sheet1: [['name', 'age'], ['Alice', 30], ['Bob', 25]] });
    const result = await convert({ base64 });
    expect(result.csv).toBe('name,age\nAlice,30\nBob,25');
    expect(result.sheet_name).toBe('Sheet1');
    expect(result.available_sheets).toEqual(['Sheet1']);
  });

  test('uses tab delimiter', async () => {
    const base64 = await makeXlsxBase64({ Sheet1: [['name', 'age'], ['Alice', 30]] });
    const result = await convert({ base64, delimiter: '\t' });
    expect(result.csv).toBe('name\tage\nAlice\t30');
  });

  test('uses semicolon delimiter', async () => {
    const base64 = await makeXlsxBase64({ Sheet1: [['name', 'age'], ['Alice', 30]] });
    const result = await convert({ base64, delimiter: ';' });
    expect(result.csv).toBe('name;age\nAlice;30');
  });

  test('selects a named sheet from a multi-sheet workbook', async () => {
    const base64 = await makeXlsxBase64({
      Employees: [['name'], ['Alice']],
      Products: [['sku'], ['P001']],
    });
    const result = await convert({ base64, sheetName: 'Products' });
    expect(result.csv).toBe('sku\nP001');
    expect(result.sheet_name).toBe('Products');
    expect(result.available_sheets).toEqual(['Employees', 'Products']);
  });

  test('defaults to first sheet when sheet_name is blank', async () => {
    const base64 = await makeXlsxBase64({
      First: [['id'], [1]],
      Second: [['id'], [2]],
    });
    const result = await convert({ base64 });
    expect(result.sheet_name).toBe('First');
  });

  test('lists sheets in workbook order, hidden sheets included', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      workbook.addWorksheet('Hidden', { state: 'hidden' }).getCell('A1').value = 'h';
      workbook.addWorksheet('Alpha').getCell('A1').value = 'a';
      workbook.addWorksheet('Beta').getCell('A1').value = 'b';
    });
    const result = await convert({ base64 });
    expect(result.available_sheets).toEqual(['Hidden', 'Alpha', 'Beta']);
    expect(result.sheet_name).toBe('Hidden');
    expect(result.csv).toBe('h');
  });

  test('throws when sheet name does not exist', async () => {
    const base64 = await makeXlsxBase64({ Sheet1: [['a'], [1]] });
    await expect(convert({ base64, sheetName: 'Missing' })).rejects.toThrow('Sheet "Missing" not found');
  });

  test('throws for a non-Excel file', async () => {
    const base64 = Buffer.from('this is not an excel file').toString('base64');
    await expect(convert({ base64 })).rejects.toThrow('does not appear to be a valid Excel file');
  });

  test('throws a clear error for a legacy .xls (OLE2) file', async () => {
    const base64 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]).toString('base64');
    await expect(convert({ base64 })).rejects.toThrow('legacy .xls (Excel 97-2003) workbook');
  });

  test('throws a clear error for a ZIP that is not a workbook', async () => {
    const base64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]).toString('base64');
    await expect(convert({ base64 })).rejects.toThrow('could not be read as an Excel workbook');
  });

  test('renders numbers and dates through their number formats, as Excel displays them', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Formats');
      const cells: [CellValue, string | undefined][] = [
        [12345.678, '#,##0.00'],
        [0.125, '0.00%'],
        [1234.5, '"$"#,##0.00'],
        [0.1 + 0.2, undefined],
        [123456789012, undefined],
        [new Date(Date.UTC(2024, 0, 15)), undefined],
        [new Date(Date.UTC(2024, 0, 15)), 'yyyy-mm-dd'],
        [new Date(Date.UTC(2024, 0, 15, 10, 30, 45)), 'yyyy-mm-dd hh:mm:ss'],
        [new Date(Date.UTC(1899, 11, 30, 14, 5)), 'h:mm AM/PM'],
        [new Date(Date.UTC(2024, 0, 15)), 'd-mmm-yy'],
        [true, undefined],
        [{ error: '#DIV/0!' }, undefined],
      ];
      cells.forEach(([value, numFmt], index) => {
        const cell = sheet.getCell(index + 1, 1);
        cell.value = value;
        if (numFmt) {
          cell.numFmt = numFmt;
        }
      });
    });
    const result = await convert({ base64, delimiter: ';' });
    expect(result.csv.split('\n')).toEqual([
      '12,345.68',
      '12.50%',
      '$1,234.50',
      '0.3',
      '1.23457E+11',
      '1/15/24',
      '2024-01-15',
      '2024-01-15 10:30:45',
      '2:05 PM',
      '15-Jan-24',
      'TRUE',
      '#DIV/0!',
    ]);
  });

  test('renders dates from a workbook on the 1904 date system', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      workbook.properties.date1904 = true;
      const cell = workbook.addWorksheet('Dates').getCell('A1');
      cell.value = new Date(Date.UTC(2024, 0, 15));
      cell.numFmt = 'yyyy-mm-dd';
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('2024-01-15');
  });

  test('renders formulas by their cached result, and as empty when there is none', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Formulas');
      sheet.getCell('B1').value = 2;
      sheet.getCell('A1').value = { formula: 'B1*2', result: 4 };
      sheet.getCell('A2').value = { sharedFormula: 'A1', result: 6 };
      sheet.getCell('A3').value = { formula: 'CONCAT("a","b")', result: 'ab' };
      sheet.getCell('A4').value = { formula: '1/0', result: { error: '#DIV/0!' } };
      sheet.getCell('A5').value = { formula: 'B1+1' };
      sheet.getCell('A6').value = { formula: 'DATE(2024,1,15)', result: new Date(Date.UTC(2024, 0, 15)) };
      sheet.getCell('A6').numFmt = 'yyyy-mm-dd';
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('4,2\n6,\nab,\n#DIV/0!,\n,\n2024-01-15,');
  });

  test('keeps the used range, blank rows, empty cells and merged cells in place', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Layout');
      sheet.getCell('C3').value = 'h1';
      sheet.getCell('D3').value = 'h2';
      sheet.getCell('F3').value = 'h4';
      sheet.getCell('C4').value = 1;
      sheet.getCell('C6').value = 'after blank row';
      sheet.getCell('F6').value = 'x';
      sheet.getCell('C8').value = 'merged';
      sheet.mergeCells('C8:E9');
      sheet.getCell('H10').font = { bold: true };
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe(
      'h1,h2,,h4,,\n1,,,,,\n,,,,,\nafter blank row,,,x,,\n,,,,,\nmerged,,,,,\n,,,,,\n,,,,,'
    );
  });

  test('returns empty CSV for an empty sheet', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      workbook.addWorksheet('Empty');
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('');
  });

  test('quotes fields containing the delimiter, a quote or a newline', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Text');
      sheet.getCell('A1').value = 'a,b';
      sheet.getCell('A2').value = 'say "hi"';
      sheet.getCell('A3').value = 'line1\nline2';
      sheet.getCell('A4').value = 'semi;colon';
      sheet.getCell('A5').value = 'ID';
      sheet.getCell('A6').value = { richText: [{ text: 'rich ', font: { bold: true } }, { text: 'text' }] };
      sheet.getCell('A7').value = { text: 'link text', hyperlink: 'https://example.com' };
    });
    const comma = await convert({ base64 });
    expect(comma.csv).toBe('"a,b"\n"say ""hi"""\n"line1\nline2"\nsemi;colon\n"ID"\nrich text\nlink text');
    const semicolon = await convert({ base64, delimiter: ';' });
    expect(semicolon.csv).toBe('a,b\n"say ""hi"""\n"line1\nline2"\n"semi;colon"\n"ID"\nrich text\nlink text');
  });

  test('falls back to General for number formats beyond what Excel can produce', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Formats');
      sheet.getCell('A1').value = 1.5;
      sheet.getCell('A1').numFmt = `0.00${'"x"'.repeat(100)}`;
      sheet.getCell('A2').value = 2.5;
      sheet.getCell('A2').numFmt = 'constructor';
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('1.5\n2.5');
  });

  test('caps a sheet at 512 distinct number formats and renders the rest as General', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Formats');
      for (let row = 1; row <= 513; row++) {
        sheet.getCell(row, 1).value = 1.5;
        sheet.getCell(row, 1).numFmt = `0.0"#${row}"`;
      }
    });
    const lines = (await convert({ base64 })).csv.split('\n');
    expect(lines).toHaveLength(513);
    expect(lines[0]).toBe('1.5#1');
    expect(lines[511]).toBe('1.5#512');
    expect(lines[512]).toBe('1.5');
  });

  test('rounds General numbers with a ten-digit integer part to ten significant digits', async () => {
    const values = [1234567890.6, -1234567890.6, 1000000000.5, 6666666666.67, 1234567890, 9999999999.5, -9999999999.5, 12345678901.6, 123456789.6];
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('General');
      values.forEach((value, index) => {
        sheet.getCell(index + 1, 1).value = value;
      });
      sheet.getCell(values.length + 1, 1).value = 1234567890.6;
      sheet.getCell(values.length + 1, 1).numFmt = 'General';
    });
    const result = await convert({ base64 });
    expect(result.csv.split('\n')).toEqual([
      '1234567891',
      '-1234567891',
      '1000000001',
      '6666666667',
      '1234567890',
      '1E+10',
      '-1E+10',
      '12345678901',
      '123456789.6',
      '1234567891',
    ]);
  });

  test('renders a negative serial under a date or time format as an empty field', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Dates');
      const cells: [number, string][] = [
        [-1234.5, 'yyyy-mm-dd'],
        [-0.5, 'h:mm'],
        [-1, 'm/d/yy h:mm'],
        [-1234.5, '0.00'],
      ];
      cells.forEach(([value, numFmt], index) => {
        const cell = sheet.getCell(index + 1, 1);
        cell.value = value;
        cell.numFmt = numFmt;
      });
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('\n\n\n-1234.50');
  });

  test('renders built-in formats 14 and 22 the way Excel displays them', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      const sheet = workbook.addWorksheet('Builtin');
      sheet.getCell('A1').value = 45306.4375;
      sheet.getCell('A1').numFmt = 'mm-dd-yy';
      sheet.getCell('A2').value = 45306.4375;
      sheet.getCell('A2').numFmt = 'm/d/yy h:mm';
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('1/15/24\n1/15/24 10:30');
  });

  test('reads a SheetJS-written workbook as the previous parser did', async () => {
    const result = await convert({ base64: SHEETJS_WRITTEN_WORKBOOK_BASE64 });
    expect(result.sheet_name).toBe('SheetJS');
    expect(result.csv).toBe('a\rb,"x\r\ny",tab\there\n1/15/24,1/15/24 12:00,1234567891\nTRUE,,');
  });

  test('decodes _xHHHH_ escapes in plain string values and formula results, and keeps escaped literals', async () => {
    const base64 = zipBase64(
      zipFixture.minimalWorkbookParts({
        sheetData:
          '<row r="1"><c r="A1" t="str"><v>cr_x000d_here</v></c></row>' +
          '<row r="2"><c r="A2" t="str"><f>"a"&amp;CHAR(13)&amp;"b"</f><v>a_x000D_b</v></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>literal _x005F_x000D_ text</t></is></c></row>',
      })
    );
    const result = await convert({ base64 });
    expect(result.csv).toBe('cr\rhere\na\rb\nliteral _x000D_ text');
  });

  test('reads dates from a workbook that declares the 1904 date system as "true"', async () => {
    const written = await buildWorkbookBase64((workbook) => {
      workbook.properties.date1904 = true;
      const cell = workbook.addWorksheet('Dates').getCell('A1');
      cell.value = new Date(Date.UTC(2024, 0, 15));
      cell.numFmt = 'yyyy-mm-dd';
    });
    const parts = readParts(written).map((part) =>
      part.name === 'xl/workbook.xml'
        ? { name: part.name, data: Buffer.from(part.data).toString('utf8').replace('date1904="1"', 'date1904="true"') }
        : part
    );
    expect(parts.find((part) => part.name === 'xl/workbook.xml')?.data).toContain('date1904="true"');
    const result = await convert({ base64: zipBase64(parts) });
    expect(result.csv).toBe('2024-01-15');
  });

  test('renders elapsed-time formats in a 1904 workbook from the serial the workbook stores', async () => {
    const base64 = await buildWorkbookBase64((workbook) => {
      workbook.properties.date1904 = true;
      const sheet = workbook.addWorksheet('Elapsed');
      const cells: [string, number | Date, string][] = [
        ['A1', 1.5, '[h]:mm'],
        ['B1', 1.5, '[mm]:ss'],
        ['C1', 0.75, 'h:mm'],
        ['D1', new Date(Date.UTC(2024, 0, 15)), 'yyyy-mm-dd'],
      ];
      cells.forEach(([address, value, numFmt]) => {
        sheet.getCell(address).value = value;
        sheet.getCell(address).numFmt = numFmt;
      });
    });
    const result = await convert({ base64 });
    expect(result.csv).toBe('36:00,2160:00,18:00,2024-01-15');
  });

  test('converts sheets, values and number formats named like built-in object members as plain text', async () => {
    const prototypeKeysBefore = builtInPrototypeKeys();
    const sheetNames = ['__proto__', 'constructor', 'prototype'];
    const base64 = await buildWorkbookBase64((workbook) => {
      for (const name of sheetNames) {
        const sheet = workbook.addWorksheet(name);
        sheet.addRow(['__proto__', 'constructor', 'prototype']);
        sheet.getCell('A2').value = 42;
        sheet.getCell('A2').numFmt = '__proto__';
        sheet.getCell('B2').value = 7;
        sheet.getCell('B2').numFmt = 'hasOwnProperty';
        if (name === 'constructor') {
          sheet.getCell('A3').value = { formula: '__proto__', result: 'x' };
        }
      }
    });

    const results = await Promise.all(sheetNames.map((sheetName) => convert({ base64, sheetName })));

    expect(builtInPrototypeKeys()).toEqual(prototypeKeysBefore);
    expect(results.map((result) => result.sheet_name)).toEqual(sheetNames);
    expect(results[0].available_sheets).toEqual(sheetNames);
    expect(results[0].csv).toBe('__proto__,constructor,prototype\n42,7,');
    expect(results[1].csv).toBe('__proto__,constructor,prototype\n42,7,\nx,,');
  });
});
