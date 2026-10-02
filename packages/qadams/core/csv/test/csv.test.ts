/// <reference types="vitest/globals" />

import { CellValue, Workbook } from 'exceljs';
import { csvToJsonAction } from '../src/lib/actions/convert-csv-to-json';
import { excelToCsvAction } from '../src/lib/actions/convert-excel-to-csv';
import { jsonToCsvAction } from '../src/lib/actions/convert-json-to-csv';
import { createMockActionContext } from '@aiqadam/qadams-framework';

async function makeXlsxBase64(sheets: Record<string, (string | number)[][]>): Promise<string> {
  return buildWorkbookBase64((workbook) => {
    for (const [name, rows] of Object.entries(sheets)) {
      workbook.addWorksheet(name).addRows(rows);
    }
  });
}

async function buildWorkbookBase64(build: (workbook: Workbook) => void): Promise<string> {
  const workbook = new Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
}

async function convert({ base64, sheetName = '', delimiter = ',' }: { base64: string; sheetName?: string; delimiter?: ',' | '\t' | ';' }) {
  const ctx = createMockActionContext({
    propsValue: { file: { base64, extension: 'xlsx', filename: 'test.xlsx' }, sheet_name: sheetName, delimiter_type: delimiter },
  });
  return excelToCsvAction.run(ctx);
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


describe('excelToCsvAction', () => {
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

  test('a workbook built around prototype keys leaves Object.prototype untouched', async () => {
    const prototypeKeysBefore = Object.getOwnPropertyNames(Object.prototype);
    const base64 = await buildWorkbookBase64((workbook) => {
      for (const name of ['__proto__', 'constructor', 'prototype']) {
        const sheet = workbook.addWorksheet(name);
        sheet.addRows([
          ['__proto__', 'constructor', 'prototype'],
          ['polluted', 'polluted', 'polluted'],
        ]);
        sheet.getCell('A2').numFmt = '__proto__';
        if (name === 'constructor') {
          sheet.getCell('A3').value = { formula: '__proto__', result: 'polluted' };
        }
      }
    });

    const results = await Promise.all(
      ['__proto__', 'constructor', 'prototype'].map((sheetName) => convert({ base64, sheetName }))
    );

    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(prototypeKeysBefore);
    expect(Object.prototype).not.toHaveProperty('polluted');
    const probe: Record<string, unknown> = {};
    expect(probe['polluted']).toBeUndefined();
    expect(results.map((result) => result.sheet_name)).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(results[0].available_sheets).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(results[0].csv).toBe('__proto__,constructor,prototype\npolluted,polluted,polluted');
    expect(results[1].csv).toBe('__proto__,constructor,prototype\npolluted,polluted,polluted\npolluted,,');
  });
});
