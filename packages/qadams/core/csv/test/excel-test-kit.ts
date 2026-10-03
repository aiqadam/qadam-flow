import { createMockActionContext } from '@aiqadam/qadams-framework';
import { Workbook } from '@cj-tech-master/excelts';
import { excelToCsvAction } from '../src/lib/actions/convert-excel-to-csv';
import { xlsxArchive } from '../src/lib/common/xlsx-archive';
import { zipFixture, ZipFixtureEntry } from './zip-fixture';

export const excelTestKit = {
  async buildWorkbookBase64(build: (workbook: Workbook) => void): Promise<string> {
    const workbook = new Workbook();
    build(workbook);
    return Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  },

  zipBase64(entries: ZipFixtureEntry[]): string {
    return zipFixture.build(entries).toString('base64');
  },

  readParts(base64: string): ZipFixtureEntry[] {
    const parts = xlsxArchive.extractEntries({ buffer: Buffer.from(base64, 'base64'), maxUncompressedBytes: Infinity, skipPart: () => false });
    return Object.entries(parts).map(([name, data]) => ({ name, data }));
  },

  builtInPrototypeKeys(): Record<string, string[]> {
    return {
      object: Reflect.ownKeys(Object.prototype).map(String),
      array: Reflect.ownKeys(Array.prototype).map(String),
      function: Reflect.ownKeys(Function.prototype).map(String),
      string: Reflect.ownKeys(String.prototype).map(String),
      number: Reflect.ownKeys(Number.prototype).map(String),
    };
  },

  async convert({ base64, sheetName = '', delimiter = ',' }: ConvertParams) {
    const ctx = createMockActionContext({
      propsValue: { file: { base64, extension: 'xlsx', filename: 'test.xlsx' }, sheet_name: sheetName, delimiter_type: delimiter },
    });
    return excelToCsvAction.run(ctx);
  },
};

type ConvertParams = {
  base64: string;
  sheetName?: string;
  delimiter?: ',' | '\t' | ';';
};
