import { createAction, Property } from '@aiqadam/qadams-framework';
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared';
import { Cell, ValueType, Workbook, Worksheet } from 'exceljs';
import { format as formatWithNumFmt } from 'numfmt';

export const excelToCsvAction = createAction({
  name: 'convert_excel_to_csv',
  displayName: 'Convert Excel to CSV',
  description: 'Converts an Excel workbook (.xlsx) into CSV text.',
  errorHandlingOptions: {
    continueOnFailure: { hide: true },
    retryOnFailure: { hide: true },
  },
  props: {
    file: Property.File({
      displayName: 'Excel File',
      description: 'The Excel file (.xlsx) to convert to CSV. Legacy .xls files must be saved as .xlsx first.',
      required: true,
    }),
    sheet_name: Property.ShortText({
      displayName: 'Sheet Name',
      description: 'Name of the sheet to convert. Leave blank to use the first sheet.',
      required: false,
    }),
    delimiter_type: Property.StaticDropdown({
      displayName: 'Delimiter',
      description: 'Character used to separate values in the output CSV.',
      defaultValue: ',',
      required: true,
      options: {
        options: [
          { label: 'Comma (,)', value: ',' },
          { label: 'Tab', value: '\t' },
          { label: 'Semicolon (;)', value: ';' },
        ],
      },
    }),
  },
  async run(context) {
    const { file, sheet_name, delimiter_type } = context.propsValue;

    const buffer = Buffer.from(file.base64, 'base64');

    // XLSX (ZIP) starts with PK\x03\x04. An OLE2 container (\xD0\xCF\x11\xE0) is either a
    // legacy .xls or a password-protected workbook, and neither can be read.
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf) {
      throw new Error(
        'This file is a legacy .xls (Excel 97-2003) workbook or a password-protected workbook, which cannot be read. ' +
        'Open it in Excel or Google Sheets, save it as an unprotected .xlsx file, and try again.'
      );
    }
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error(
        'The file does not appear to be a valid Excel file (.xlsx). ' +
        'If you supplied a URL, make sure it points directly to the file download, not a webpage.'
      );
    }

    const workbook = new Workbook();
    const { error: loadError } = await tryCatch(() =>
      workbook.xlsx.load(buffer, { ignoreNodes: UNUSED_WORKSHEET_NODES })
    );
    if (!isNil(loadError)) {
      throw new Error(`The file could not be read as an Excel workbook (.xlsx): ${loadError.message}`);
    }

    const sheetNames = workbook.worksheets.map((worksheet) => worksheet.name);
    if (sheetNames.length === 0) {
      throw new Error('The workbook does not contain any sheets.');
    }

    const targetSheet = sheet_name?.trim() || sheetNames[0];
    const worksheet = workbook.worksheets.find((candidate) => candidate.name === targetSheet);

    if (isNil(worksheet)) {
      throw new Error(
        `Sheet "${targetSheet}" not found. Available sheets: ${sheetNames.join(', ')}`
      );
    }

    return {
      csv: worksheetToCsv({ worksheet, delimiter: delimiter_type }),
      sheet_name: targetSheet,
      available_sheets: sheetNames,
    };
  },
});

// Only cell data and merges are read; skipping the rest of the worksheet XML keeps markup
// this action never uses away from the parser.
const UNUSED_WORKSHEET_NODES = [
  'sheetPr',
  'dimension',
  'sheetViews',
  'sheetFormatPr',
  'cols',
  'autoFilter',
  'rowBreaks',
  'hyperlinks',
  'pageMargins',
  'dataValidations',
  'pageSetup',
  'headerFooter',
  'printOptions',
  'picture',
  'drawing',
  'sheetProtection',
  'tableParts',
  'conditionalFormatting',
  'extLst',
];

// numfmt caches every pattern it parses for the life of the process (~6 KB each), and parse
// time grows with pattern length. Excel itself caps a workbook at roughly 250 custom formats
// of at most 255 characters, so anything beyond these bounds only comes from a crafted file
// and is rendered with General instead.
const MAX_DISTINCT_NUMBER_FORMATS = 512;
const MAX_NUMBER_FORMAT_LENGTH = 255;

const GENERAL_FORMAT = 'General';

// exceljs resolves built-in format 14 to the ECMA-376 literal "mm-dd-yy" and 22 to a pattern
// with a stray quoted "h"; Excel and the previous parser render them as below.
const BUILT_IN_FORMAT_CORRECTIONS = new Map<string, string>([
  ['mm-dd-yy', 'm/d/yy'],
  ['m/d/yy "h":mm', 'm/d/yy h:mm'],
]);

const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86_400_000;

function worksheetToCsv({ worksheet, delimiter }: { worksheet: Worksheet; delimiter: string }): string {
  const range = findUsedRange(worksheet);
  if (isNil(range)) {
    return '';
  }
  const rows = sequence({ from: range.top, to: range.bottom }).map((rowNumber) => {
    const row = worksheet.findRow(rowNumber);
    return sequence({ from: range.left, to: range.right }).map((columnNumber) => row?.findCell(columnNumber));
  });
  const numberFormats = pickNumberFormats(rows);
  return rows
    .map((cells) =>
      cells
        .map((cell) => toCsvField({ text: cellText({ cell, numberFormats }), delimiter }))
        .join(delimiter)
    )
    .join('\n');
}

// The bounding box of every cell present in the sheet XML, styled-but-empty cells included,
// which is what Excel records as the sheet's used range.
function findUsedRange(worksheet: Worksheet): UsedRange | null {
  const occupiedRows = sequence({ from: 1, to: worksheet.rowCount }).flatMap((rowNumber) => {
    const row = worksheet.findRow(rowNumber);
    if (isNil(row)) {
      return [];
    }
    const columns = sequence({ from: 1, to: row.cellCount }).filter(
      (columnNumber) => !isNil(row.findCell(columnNumber))
    );
    if (columns.length === 0) {
      return [];
    }
    return [{ rowNumber, left: columns[0], right: columns[columns.length - 1] }];
  });
  if (occupiedRows.length === 0) {
    return null;
  }
  return occupiedRows.reduce<UsedRange>(
    (range, { rowNumber, left, right }) => ({
      top: Math.min(range.top, rowNumber),
      bottom: Math.max(range.bottom, rowNumber),
      left: Math.min(range.left, left),
      right: Math.max(range.right, right),
    }),
    { top: Infinity, bottom: 0, left: Infinity, right: 0 }
  );
}

function pickNumberFormats(rows: (Cell | undefined)[][]): ReadonlySet<string> {
  const patterns = rows
    .flat()
    .map((cell) => (isNil(cell) ? undefined : normalizeNumberFormat(cell.numFmt)))
    .filter((pattern): pattern is string => !isNil(pattern) && pattern.length <= MAX_NUMBER_FORMAT_LENGTH);
  return new Set([...new Set(patterns)].slice(0, MAX_DISTINCT_NUMBER_FORMATS));
}

function normalizeNumberFormat(numFmt: string | undefined): string {
  if (isNil(numFmt) || numFmt === '') {
    return GENERAL_FORMAT;
  }
  return BUILT_IN_FORMAT_CORRECTIONS.get(numFmt) ?? numFmt;
}

function cellText({ cell, numberFormats }: { cell: Cell | undefined; numberFormats: ReadonlySet<string> }): string {
  if (isNil(cell)) {
    return '';
  }
  const pattern = normalizeNumberFormat(cell.numFmt);
  const numberFormat = numberFormats.has(pattern) ? pattern : GENERAL_FORMAT;
  switch (cell.type) {
    case ValueType.Null:
    case ValueType.Merge:
      return '';
    case ValueType.Formula:
      return valueText({ value: cell.result, numberFormat });
    default:
      return valueText({ value: cell.value, numberFormat });
  }
}

function valueText({ value, numberFormat }: { value: unknown; numberFormat: string }): string {
  if (typeof value === 'number') {
    return formatNumber({ value, numberFormat });
  }
  if (value instanceof Date) {
    return formatNumber({ value: value.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS, numberFormat });
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText.map(richTextPartText).join('');
  }
  if ('error' in value && typeof value.error === 'string') {
    return value.error;
  }
  if ('text' in value) {
    return valueText({ value: value.text, numberFormat });
  }
  return '';
}

function richTextPartText(part: unknown): string {
  if (typeof part === 'object' && !isNil(part) && 'text' in part && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function formatNumber({ value, numberFormat }: { value: number; numberFormat: string }): string {
  const formatted = tryCatchSync(() => formatWithNumFmt(numberFormat, value));
  if (formatted.error === null) {
    return formatted.data;
  }
  return formatWithNumFmt(GENERAL_FORMAT, value);
}

function toCsvField({ text, delimiter }: { text: string; delimiter: string }): string {
  if (text.includes(delimiter) || text.includes('\n') || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  // Quoted wherever it appears, as the previous parser did: a bare ID at the start of a file
  // makes Excel misread the CSV as SYLK.
  if (text === 'ID') {
    return '"ID"';
  }
  return text;
}

function sequence({ from, to }: { from: number; to: number }): number[] {
  return to < from ? [] : Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

type UsedRange = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};
