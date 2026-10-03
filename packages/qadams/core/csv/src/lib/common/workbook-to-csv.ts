import { Cell, ValueType, Workbook, Worksheet } from '@cj-tech-master/excelts';
import { format as formatWithNumFmt, isDateFormat } from 'numfmt';
import { conversionErrors } from './conversion-errors';
import { ConversionRequest, ConvertedSheet, MAX_CSV_LENGTH } from './conversion-protocol';
import { prototypeIntegrity } from './prototype-integrity';
import { workerUtils } from './worker-utils';

// Loads a workbook and builds the CSV of one of its sheets. This is the part of the conversion
// whose memory grows with the workbook, so the action runs it in a worker thread of its own
// (see conversion-worker.ts) rather than in the engine's.
export const workbookToCsv = {
  async convert({ parts, sheetName, delimiter }: ConversionRequest): Promise<ConvertedSheet> {
    const workbook = new Workbook();
    const { error: loadError } = await workerUtils.tryCatch(() =>
      workbook.xlsx.loadFromFiles(parts, {
        maxRows: MAX_SHEET_ROWS,
        maxCols: MAX_SHEET_COLUMNS,
        ignoreNodes: UNUSED_WORKSHEET_NODES,
      })
    );
    if (!workerUtils.isNil(loadError)) {
      throw conversionErrors.unreadableWorkbook(loadError.message);
    }

    const sheetNames = workbook.worksheets.map((worksheet) => worksheet.name);
    if (sheetNames.length === 0) {
      throw new Error('The workbook does not contain any sheets.');
    }

    const targetSheet = sheetName?.trim() || sheetNames[0];
    const worksheet = workbook.worksheets.find((candidate) => candidate.name === targetSheet);
    if (workerUtils.isNil(worksheet)) {
      throw new Error(`Sheet "${targetSheet}" not found. Available sheets: ${sheetNames.join(', ')}`);
    }

    const csv = worksheetToCsv({ worksheet, delimiter, date1904: workbook.properties.date1904 === true });
    return { csv, sheet_name: targetSheet, available_sheets: sheetNames };
  },

  // A parser that modifies a built-in prototype could change how the rest of the conversion
  // behaves, so a conversion during which one changed fails instead of returning output.
  convertGuarded(request: ConversionRequest): Promise<ConvertedSheet> {
    return prototypeIntegrity.guard(() => workbookToCsv.convert(request));
  },
};

// Excel's own sheet limits; a file with more row or cell elements than this is not one Excel
// wrote, and the parser stops at the limit instead of materialising the rest.
const MAX_SHEET_ROWS = 1_048_576;
const MAX_SHEET_COLUMNS = 16_384;

// The used range of the converted sheet is materialised field by field, so a sparse sheet
// with one cell at A1 and another at XFD1048576 would otherwise expand to 17 billion fields.
const MAX_SHEET_CELLS = 5_000_000;

// Only cell data is read, so every other node the parser maps in a worksheet is skipped, and
// markup this action never uses stays away from the parser. Merged ranges are among it: the
// CSV puts a merged value in its top-left cell only, as the cells themselves do, and the
// parser would otherwise materialise every cell a merged range covers. A test checks this list
// against the parser's own worksheet map.
const UNUSED_WORKSHEET_NODES = [
  'sheetPr',
  'dimension',
  'sheetViews',
  'sheetFormatPr',
  'cols',
  'autoFilter',
  'mergeCells',
  'rowBreaks',
  'colBreaks',
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
  'ignoredErrors',
];

// numfmt caches every pattern it parses (~6 KB each), and parse time grows with pattern
// length. Excel itself caps a workbook at roughly 250 custom formats of at most 255 characters,
// so a pattern beyond these bounds is rendered with General. The cache lives in the conversion
// worker and goes with it, so nothing carries over from one conversion to the next.
const MAX_DISTINCT_NUMBER_FORMATS = 512;
const MAX_NUMBER_FORMAT_LENGTH = 255;

const GENERAL_FORMAT = 'General';
const SCIENTIFIC_FORMAT = '0E+00';

// The parser resolves built-in format 14 to the ECMA-376 literal "mm-dd-yy"; Excel and the
// previous parser render it as below.
const BUILT_IN_FORMAT_CORRECTIONS = new Map<string, string>([['mm-dd-yy', 'm/d/yy']]);

const XML_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

const TEN_DIGIT_BAND_START = 1e9;
const TEN_DIGIT_BAND_END = 1e10;

const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const DATE_1904_OFFSET_DAYS = 1462;
const MS_PER_DAY = 86_400_000;
const ELAPSED_TIME_TOKEN = /\[(?:h+|m+|s+)\]/i;

function worksheetToCsv({ worksheet, delimiter, date1904 }: WorksheetToCsvParams): string {
  const range = findUsedRange(worksheet);
  if (workerUtils.isNil(range)) {
    return '';
  }
  const height = range.bottom - range.top + 1;
  const width = range.right - range.left + 1;
  if (height * width > MAX_SHEET_CELLS) {
    throw new Error(
      `Sheet "${worksheet.name}" is too large to convert: its used range is ${height} rows by ${width} columns, ` +
      `more than the ${MAX_SHEET_CELLS.toLocaleString('en-US')} cells a conversion allows. ` +
      'Delete unused rows and columns, or split the sheet, and try again.'
    );
  }
  const rows = sequence({ from: range.top, to: range.bottom }).map((rowNumber) => {
    const row = worksheet.findRow(rowNumber);
    return sequence({ from: range.left, to: range.right }).map((columnNumber) => row?.findCell(columnNumber));
  });
  const numberFormats = pickNumberFormats(rows);
  // One shared string may be referenced by every cell of a sheet, so a small workbook can
  // expand to a CSV longer than a string can be. The length is counted field by field and the
  // conversion stops as soon as it passes the cap, before any oversized string is built.
  const lines: string[] = [];
  let length = 0;
  for (const [rowIndex, cells] of rows.entries()) {
    const fields: string[] = [];
    for (const [columnIndex, cell] of cells.entries()) {
      const field = toCsvField({ text: cellText({ cell, numberFormats, date1904 }), delimiter });
      length += separatorLength({ rowIndex, columnIndex, delimiter }) + field.length;
      if (length > MAX_CSV_LENGTH) {
        throw new Error(
          `Sheet "${worksheet.name}" is too large to convert: its CSV would be longer than ${MAX_CSV_LENGTH.toLocaleString('en-US')} characters. ` +
          'Delete unused rows and columns, or split the sheet, and try again.'
        );
      }
      fields.push(field);
    }
    lines.push(fields.join(delimiter));
  }
  return lines.join('\n');
}

function separatorLength({ rowIndex, columnIndex, delimiter }: { rowIndex: number; columnIndex: number; delimiter: string }): number {
  if (columnIndex > 0) {
    return delimiter.length;
  }
  return rowIndex > 0 ? 1 : 0;
}

// The bounding box of every cell present in the sheet XML, styled-but-empty cells included,
// which is what Excel records as the sheet's used range. Only rows and cells that exist are
// visited, so a sparse sheet costs no more than the cells it actually holds.
function findUsedRange(worksheet: Worksheet): UsedRange | null {
  const rows = worksheet.findRows(1, worksheet.rowCount) ?? [];
  return rows.reduce<UsedRange | null>((range, row) => {
    const model = row?.model;
    if (workerUtils.isNil(model) || model.cells.length === 0) {
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
    .map((cell) => (workerUtils.isNil(cell) ? undefined : normalizeNumberFormat(cell.numFmt)))
    .filter((pattern): pattern is string => !workerUtils.isNil(pattern) && pattern.length <= MAX_NUMBER_FORMAT_LENGTH);
  return new Set([...new Set(patterns)].slice(0, MAX_DISTINCT_NUMBER_FORMATS));
}

function normalizeNumberFormat(numFmt: Cell['numFmt']): string {
  const pattern = typeof numFmt === 'object' ? numFmt.formatCode : numFmt;
  if (workerUtils.isNil(pattern) || pattern === '') {
    return GENERAL_FORMAT;
  }
  return BUILT_IN_FORMAT_CORRECTIONS.get(pattern) ?? pattern;
}

function cellText({ cell, numberFormats, date1904 }: { cell: Cell | undefined; numberFormats: ReadonlySet<string>; date1904: boolean }): string {
  if (workerUtils.isNil(cell)) {
    return '';
  }
  const pattern = normalizeNumberFormat(cell.numFmt);
  const numberFormat = numberFormats.has(pattern) ? pattern : GENERAL_FORMAT;
  switch (cell.type) {
    case ValueType.Null:
    case ValueType.Merge:
      return '';
    case ValueType.Formula:
      return valueText({ value: cell.result, numberFormat, escapes: 'all', date1904 });
    default:
      return valueText({ value: cell.value, numberFormat, escapes: 'lower-case', date1904 });
  }
}

function valueText({ value, numberFormat, escapes, date1904 }: ValueTextParams): string {
  if (typeof value === 'number') {
    return formatNumber({ value, numberFormat });
  }
  if (value instanceof Date) {
    return formatNumber({ value: dateToSerial({ date: value, numberFormat, date1904 }), numberFormat });
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
    return valueText({ value: value.text, numberFormat, escapes, date1904 });
  }
  return '';
}

// The parser turns a serial under a date format into an absolute Date. numfmt only knows the
// 1900 date system, so the Date goes back to a 1900 serial, which shows the same calendar date
// whichever system the workbook uses. An elapsed-time pattern shows the serial itself as a
// duration, so in a 1904 workbook it gets the serial the workbook stores.
function dateToSerial({ date, numberFormat, date1904 }: { date: Date; numberFormat: string; date1904: boolean }): number {
  const serial = date.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS;
  return date1904 && ELAPSED_TIME_TOKEN.test(numberFormat) ? serial - DATE_1904_OFFSET_DAYS : serial;
}

// The parser decodes _xHHHH_ escapes in shared and inline strings, but not in t="str" values:
// formula string results, and the plain string cells SheetJS writes (with lower-case hex, e.g.
// _x000d_ for a carriage return). A formula result is decoded in full. A plain string may
// already be decoded, and an escape left in it then is a literal its writer escaped on purpose
// as _x005F_xHHHH_, which Excel writes in upper case, so only escapes with a lower-case hex
// digit are decoded. An all-digit escape (_x0001_) in a plain t="str" value stays as text: it
// cannot be told apart from a decoded literal once the parser has resolved shared strings.
function decodeEscapes({ text, escapes }: { text: string; escapes: EscapeDecoding }): string {
  if (!text.includes('_x')) {
    return text;
  }
  return text.replace(XML_ESCAPE, (escape, hex: string) =>
    escapes === 'lower-case' && hex === hex.toUpperCase() ? escape : String.fromCharCode(parseInt(hex, 16))
  );
}

function richTextPartText(part: unknown): string {
  if (typeof part === 'object' && !workerUtils.isNil(part) && 'text' in part && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function formatNumber({ value, numberFormat }: { value: number; numberFormat: string }): string {
  const formatted = workerUtils.tryCatchSync(() => formatWithPattern({ value, pattern: numberFormat }));
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

type WorksheetToCsvParams = {
  worksheet: Worksheet;
  delimiter: string;
  date1904: boolean;
};

type EscapeDecoding = 'all' | 'lower-case';

type ValueTextParams = {
  value: unknown;
  numberFormat: string;
  escapes: EscapeDecoding;
  date1904: boolean;
};
