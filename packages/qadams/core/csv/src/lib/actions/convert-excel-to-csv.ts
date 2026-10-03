import { createAction, Property } from '@aiqadam/qadams-framework';
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared';
import { Cell, ValueType, Workbook, Worksheet } from '@cj-tech-master/excelts';
import { format as formatWithNumFmt, isDateFormat } from 'numfmt';
import { prototypeIntegrity } from '../common/prototype-integrity';
import { xlsxArchive, XlsxArchiveError } from '../common/xlsx-archive';


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
      throw new Error(LEGACY_OR_PROTECTED_MESSAGE);
    }
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error(
        'The file does not appear to be a valid Excel file (.xlsx). ' +
        'If you supplied a URL, make sure it points directly to the file download, not a webpage.'
      );
    }

    const extracted = tryCatchSync(() =>
      xlsxArchive.extractEntries({
        buffer,
        maxUncompressedBytes: MAX_UNCOMPRESSED_WORKBOOK_BYTES,
        skipPart: isUnusedPart,
      })
    );
    if (extracted.error !== null) {
      throw archiveErrorToUserError(extracted.error);
    }
    const parts = withDate1904FlagNormalized(extracted.data);

    return prototypeIntegrity.guard(async () => {
      const workbook = new Workbook();
      const { error: loadError } = await tryCatch(() =>
        workbook.xlsx.loadFromFiles(parts, {
          maxRows: MAX_SHEET_ROWS,
          maxCols: MAX_SHEET_COLUMNS,
          ignoreNodes: UNUSED_WORKSHEET_NODES,
        })
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
    });
  },
});

const LEGACY_OR_PROTECTED_MESSAGE =
  'This file is a legacy .xls (Excel 97-2003) workbook or a password-protected workbook, which cannot be read. ' +
  'Open it in Excel or Google Sheets, save it as an unprotected .xlsx file, and try again.';

// The parser keeps the whole workbook in memory, at several times its decompressed size, so a
// workbook beyond this is refused before it is parsed.
const MAX_UNCOMPRESSED_WORKBOOK_BYTES = 100 * 1024 * 1024;

// Excel's own sheet limits; a file with more row or cell elements than this is not one Excel
// wrote, and the parser stops at the limit instead of materialising the rest.
const MAX_SHEET_ROWS = 1_048_576;
const MAX_SHEET_COLUMNS = 16_384;

// The used range of the converted sheet is materialised cell by cell, so a sparse sheet with
// one cell at A1 and another at XFD1048576 would otherwise expand to 17 billion fields.
const MAX_SHEET_CELLS = 5_000_000;

// Parts the CSV never reads. They are not handed to the parser at all: charts make it fail
// unless chart support is installed, and images, embedded objects and pivot caches are often
// the bulk of a workbook's size.
const UNUSED_PART_PREFIXES = [
  'xl/charts/',
  'xl/drawings/',
  'xl/media/',
  'xl/embeddings/',
  'xl/pivotTables/',
  'xl/pivotCache/',
  'xl/printerSettings/',
  'customXml/',
  'docProps/',
];

const WORKBOOK_PART = 'xl/workbook.xml';

// xsd:boolean allows "true" as well as "1", and SheetJS writes date1904="true", but the parser
// only recognises "1" and would read such a workbook's dates four years and a day early.
const DATE_1904_TRUE_ATTRIBUTE = /(<(?:\w+:)?workbookPr\b[^<>]*?\bdate1904\s*=\s*)(["'])true\2/;

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
// and is rendered with General instead. The process-wide bound keeps the cache from growing
// run after run in a long-lived engine process.
const MAX_DISTINCT_NUMBER_FORMATS = 512;
const MAX_NUMBER_FORMAT_LENGTH = 255;
const MAX_PROCESS_NUMBER_FORMATS = 4096;
const numberFormatsSeenByProcess = new Set<string>();

const GENERAL_FORMAT = 'General';
const SCIENTIFIC_FORMAT = '0E+00';

// The parser resolves built-in format 14 to the ECMA-376 literal "mm-dd-yy"; Excel and the
// previous parser render it as below.
const BUILT_IN_FORMAT_CORRECTIONS = new Map<string, string>([['mm-dd-yy', 'm/d/yy']]);

const XML_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

const TEN_DIGIT_BAND_START = 1e9;
const TEN_DIGIT_BAND_END = 1e10;

const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86_400_000;

function archiveErrorToUserError(error: Error): Error {
  if (!(error instanceof XlsxArchiveError)) {
    return new Error(`The file could not be read as an Excel workbook (.xlsx): ${error.message}`);
  }
  switch (error.reason) {
    case 'too-large':
      return new Error(
        `The workbook is too large to convert: its contents exceed ${MAX_UNCOMPRESSED_WORKBOOK_BYTES / (1024 * 1024)} MB once decompressed. ` +
        'Split it into smaller workbooks, or delete unused sheets, and try again.'
      );
    case 'encrypted':
      return new Error(LEGACY_OR_PROTECTED_MESSAGE);
    case 'corrupt':
      return new Error(`The file could not be read as an Excel workbook (.xlsx): ${error.message}`);
  }
}

function isUnusedPart(name: string): boolean {
  return UNUSED_PART_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function withDate1904FlagNormalized(parts: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const workbookXml = parts[WORKBOOK_PART];
  if (isNil(workbookXml)) {
    return parts;
  }
  const text = Buffer.from(workbookXml).toString('utf8');
  if (!DATE_1904_TRUE_ATTRIBUTE.test(text)) {
    return parts;
  }
  return { ...parts, [WORKBOOK_PART]: Buffer.from(text.replace(DATE_1904_TRUE_ATTRIBUTE, '$1$21$2'), 'utf8') };
}

function worksheetToCsv({ worksheet, delimiter }: { worksheet: Worksheet; delimiter: string }): string {
  const range = findUsedRange(worksheet);
  if (isNil(range)) {
    return '';
  }
  const height = range.bottom - range.top + 1;
  const width = range.right - range.left + 1;
  if (height * width > MAX_SHEET_CELLS) {
    throw new Error(
      `Sheet "${worksheet.name}" is too large to convert: its used range is ${height} rows by ${width} columns, ` +
      `more than ${MAX_SHEET_CELLS.toLocaleString('en-US')} cells. ` +
      'Delete unused rows and columns, or split the sheet, and try again.'
    );
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
// which is what Excel records as the sheet's used range. Only rows and cells that exist are
// visited, so a sparse sheet costs no more than the cells it actually holds.
function findUsedRange(worksheet: Worksheet): UsedRange | null {
  const rows = worksheet.findRows(1, worksheet.rowCount) ?? [];
  return rows.reduce<UsedRange | null>((range, row) => {
    const model = row?.model;
    if (isNil(model) || model.cells.length === 0) {
      return range;
    }
    return {
      top: Math.min(range?.top ?? Infinity, model.number),
      bottom: Math.max(range?.bottom ?? 0, model.number),
      left: Math.min(range?.left ?? Infinity, model.min),
      right: Math.max(range?.right ?? 0, model.max),
    };
  }, null);
}

function pickNumberFormats(rows: (Cell | undefined)[][]): ReadonlySet<string> {
  const patterns = rows
    .flat()
    .map((cell) => (isNil(cell) ? undefined : normalizeNumberFormat(cell.numFmt)))
    .filter((pattern): pattern is string => !isNil(pattern) && pattern.length <= MAX_NUMBER_FORMAT_LENGTH);
  const perSheet = [...new Set(patterns)].slice(0, MAX_DISTINCT_NUMBER_FORMATS);
  return new Set(perSheet.filter(admitToProcessCache));
}

function admitToProcessCache(pattern: string): boolean {
  if (numberFormatsSeenByProcess.has(pattern)) {
    return true;
  }
  if (numberFormatsSeenByProcess.size >= MAX_PROCESS_NUMBER_FORMATS) {
    return false;
  }
  numberFormatsSeenByProcess.add(pattern);
  return true;
}

function normalizeNumberFormat(numFmt: Cell['numFmt']): string {
  const pattern = typeof numFmt === 'object' ? numFmt.formatCode : numFmt;
  if (isNil(pattern) || pattern === '') {
    return GENERAL_FORMAT;
  }
  return BUILT_IN_FORMAT_CORRECTIONS.get(pattern) ?? pattern;
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
      return valueText({ value: cell.result, numberFormat, escapes: 'all' });
    default:
      return valueText({ value: cell.value, numberFormat, escapes: 'lower-case' });
  }
}

function valueText({ value, numberFormat, escapes }: { value: unknown; numberFormat: string; escapes: EscapeDecoding }): string {
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
    return decodeEscapes({ text: value, escapes });
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
    return valueText({ value: value.text, numberFormat, escapes });
  }
  return '';
}

// The parser decodes _xHHHH_ escapes in shared and inline strings, but not in t="str" values:
// formula string results, and the plain string cells SheetJS writes (with lower-case hex, e.g.
// _x000d_ for a carriage return). A formula result is decoded in full. A plain string may
// already be decoded, and an escape left in it then is a literal its writer escaped on purpose
// as _x005F_xHHHH_, which Excel writes in upper case, so only lower-case escapes are decoded.
function decodeEscapes({ text, escapes }: { text: string; escapes: EscapeDecoding }): string {
  if (!text.includes('_x')) {
    return text;
  }
  return text.replace(XML_ESCAPE, (escape, hex: string) =>
    escapes === 'lower-case' && hex === hex.toUpperCase() ? escape : String.fromCharCode(parseInt(hex, 16))
  );
}

function richTextPartText(part: unknown): string {
  if (typeof part === 'object' && !isNil(part) && 'text' in part && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function formatNumber({ value, numberFormat }: { value: number; numberFormat: string }): string {
  const formatted = tryCatchSync(() => formatWithPattern({ value, pattern: numberFormat }));
  if (formatted.error === null) {
    return formatted.data;
  }
  return formatWithPattern({ value, pattern: GENERAL_FORMAT });
}

function formatWithPattern({ value, pattern }: { value: number; pattern: string }): string {
  if (isGeneral(pattern)) {
    return formatGeneral(value);
  }
  // Excel shows a negative serial under a date or time format as ####; the previous parser
  // emitted an empty field, and numfmt would print a date before 1900.
  if (value < 0 && isDateFormat(pattern)) {
    return '';
  }
  return formatWithNumFmt(pattern, value);
}

function isGeneral(pattern: string): boolean {
  return pattern.toLowerCase() === GENERAL_FORMAT.toLowerCase();
}

// General shows at most ten significant digits for a number whose integer part has ten digits,
// rounding the fraction away; numfmt 3.2.6 truncates it instead (1234567890.6 -> 1234567890).
// A value that rounds up to 1e10 no longer fits and is shown in scientific notation.
function formatGeneral(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude < TEN_DIGIT_BAND_START || magnitude >= TEN_DIGIT_BAND_END || Number.isInteger(value)) {
    return formatWithNumFmt(GENERAL_FORMAT, value);
  }
  const rounded = Math.sign(value) * Math.round(magnitude);
  if (Math.abs(rounded) >= TEN_DIGIT_BAND_END) {
    return formatWithNumFmt(SCIENTIFIC_FORMAT, rounded);
  }
  return formatWithNumFmt(GENERAL_FORMAT, rounded);
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

type EscapeDecoding = 'all' | 'lower-case';
