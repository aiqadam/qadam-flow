import { isUtf8 } from 'node:buffer';
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
    assertPartsAreUtf8(extracted.data);
    const parts = withWorkbookPartPrepared(extracted.data);
    const loadEstimate = estimateLoadWithinBudget(parts);
    const maxFields = Math.min(MAX_SHEET_CELLS, Math.floor((LOAD_BUDGET_BYTES - loadEstimate) / HEAP_BYTES_PER_FIELD));

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
        throw unreadableWorkbookError(loadError.message);
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
        csv: worksheetToCsv({ worksheet, delimiter: delimiter_type, date1904: workbook.properties.date1904 === true, maxFields }),
        sheet_name: targetSheet,
        available_sheets: sheetNames,
      };
    });
  },
});

const LEGACY_OR_PROTECTED_MESSAGE =
  'This file is a legacy .xls (Excel 97-2003) workbook or a password-protected workbook, which cannot be read. ' +
  'Open it in Excel or Google Sheets, save it as an unprotected .xlsx file, and try again.';

const MEBIBYTE = 1024 * 1024;

// The parser's memory grows with the XML it is given: by up to HEAP_BYTES_PER_INPUT_BYTE for
// every byte (the worst case is markup it accumulates one character at a time) and by up to
// HEAP_BYTES_PER_ELEMENT more for every element it opens. Both rates are at or above the worst
// measured for every kind of markup and element, so the estimate never undercounts whatever
// the XML holds. A workbook whose estimate exceeds the budget is refused before the parser
// runs. What the estimate leaves of the budget bounds the CSV, at HEAP_BYTES_PER_FIELD for
// every field of the used range, so loading and converting together stay within it: at the
// budget, the worst measured conversion peaked under 600 MB, inside the engine's default 1 GB
// sandbox.
const LOAD_BUDGET_BYTES = 480 * MEBIBYTE;
const HEAP_BYTES_PER_INPUT_BYTE = 48;
const HEAP_BYTES_PER_ELEMENT = 300;
const HEAP_BYTES_PER_FIELD = 64;

// No workbook whose parts add up to more than this fits the budget, so the archive reader
// refuses it from the sizes it declares, before anything is inflated.
const MAX_UNCOMPRESSED_WORKBOOK_BYTES = LOAD_BUDGET_BYTES / HEAP_BYTES_PER_INPUT_BYTE;

// Excel's own sheet limits; a file with more row or cell elements than this is not one Excel
// wrote, and the parser stops at the limit instead of materialising the rest.
const MAX_SHEET_ROWS = 1_048_576;
const MAX_SHEET_COLUMNS = 16_384;

// The used range of the converted sheet is materialised field by field, so a sparse sheet
// with one cell at A1 and another at XFD1048576 would otherwise expand to 17 billion fields.
// The load budget can lower this further for a workbook that is large itself.
const MAX_SHEET_CELLS = 5_000_000;

const WORKBOOK_PART = 'xl/workbook.xml';
const SHARED_STRINGS_PART = 'xl/sharedStrings.xml';
const STYLES_PART = 'xl/styles.xml';
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;

// The only parts the CSV is built from; the parser recognises worksheets by this path alone.
// Everything else (charts, drawings, media, comments, tables, pivot caches, themes, document
// properties, ...) is never inflated: some of it makes the parser fail without optional
// support installed, and all of it would cost memory for nothing.
const CONVERTED_PARTS = new Set(['_rels/.rels', WORKBOOK_PART, 'xl/_rels/workbook.xml.rels', SHARED_STRINGS_PART, STYLES_PART]);

// A namespace prefix: one or more segments of any characters that cannot end a name, non-ASCII
// included, each followed by a colon.
const NAMESPACE_PREFIX = String.raw`(?:[^\s<>/:]+:)*`;

// xsd:boolean allows "true" as well as "1", and SheetJS writes date1904="true", but the parser
// only recognises "1" and would read such a workbook's dates four years and a day early.
const DATE_1904_TRUE_ATTRIBUTE = new RegExp(String.raw`(<${NAMESPACE_PREFIX}workbookPr\b[^<>]*?\bdate1904\s*=\s*)(["'])true\2`);

// The CSV never uses defined names, and the parser materialises every cell a defined name
// covers. Renaming the element, in its opening and closing tags alike, leaves the XML well
// formed and makes the parser skip it with everything inside. A workbook part in which the
// element can still be found after renaming is refused rather than loaded.
const DEFINED_NAMES_TAG = new RegExp(String.raw`<(\/?)(${NAMESPACE_PREFIX})definedNames`, 'g');
const IGNORED_DEFINED_NAMES_TAG = 'ignoredDefinedNames';
const REMAINING_DEFINED_NAMES_TAG = /[<:/]definedNames/;

// The parser silently drops these characters wherever they appear, so markup split by one
// would be read as markup the checks above never saw. XML forbids them, and Excel never writes
// them; a workbook.xml holding one is refused.
const SKIPPED_CONTROL_BYTES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f]);
const SKIPPED_NON_CHARACTERS = [Buffer.from([0xef, 0xbf, 0xbe]), Buffer.from([0xef, 0xbf, 0xbf])];

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

const LESS_THAN = 0x3c;
// After "<", these open an end tag, a comment, CDATA, a declaration or a processing
// instruction rather than an element.
const NON_ELEMENT_MARKERS = new Set([0x2f, 0x21, 0x3f]);

// numfmt caches every pattern it parses for the life of the process (~6 KB each), and parse
// time grows with pattern length. Excel itself caps a workbook at roughly 250 custom formats
// of at most 255 characters, so a pattern beyond these bounds is rendered with General. The
// process-wide bound keeps the cache from growing run after run in a long-lived engine
// process.
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
const DATE_1904_OFFSET_DAYS = 1462;
const MS_PER_DAY = 86_400_000;
const ELAPSED_TIME_TOKEN = /\[(?:h+|m+|s+)\]/i;

function archiveErrorToUserError(error: Error): Error {
  if (!(error instanceof XlsxArchiveError)) {
    return unreadableWorkbookError(error.message);
  }
  switch (error.reason) {
    case 'too-large':
      return new Error(
        `The workbook is too large to convert: its contents exceed ${MAX_UNCOMPRESSED_WORKBOOK_BYTES / MEBIBYTE} MB once decompressed. ` +
        'Split it into smaller workbooks, or delete unused sheets, and try again.'
      );
    case 'encrypted':
      return new Error(LEGACY_OR_PROTECTED_MESSAGE);
    case 'corrupt':
      return unreadableWorkbookError(error.message);
  }
}

function isUnusedPart(name: string): boolean {
  return !CONVERTED_PARTS.has(name) && !WORKSHEET_PART.test(name);
}

// The parser decodes a part it is given without checking it, so a part that is not valid UTF-8
// is refused here instead.
function assertPartsAreUtf8(parts: Record<string, Uint8Array>): void {
  const invalid = Object.keys(parts).find((name) => !isUtf8(parts[name]));
  if (!isNil(invalid)) {
    throw unreadableWorkbookError(`${invalid} is not valid UTF-8 text.`);
  }
}

// Estimated on the exact XML the parser will be given, before it runs, because the parser
// allocates as it reads: a workbook over budget is refused before any of it is materialised.
function estimateLoadWithinBudget(parts: Record<string, Uint8Array>): number {
  const estimate = Object.values(parts).reduce(
    (total, bytes) => (total > LOAD_BUDGET_BYTES ? total : total + partLoadEstimate({ bytes, remaining: LOAD_BUDGET_BYTES - total })),
    0
  );
  if (estimate > LOAD_BUDGET_BYTES) {
    throw new Error(
      'The workbook is too large to convert: its cells, rows, strings and styles, counting empty ones, need more memory than a ' +
      'conversion may use. Delete unused rows and columns, or split the workbook, and try again.'
    );
  }
  return estimate;
}

function partLoadEstimate({ bytes, remaining }: { bytes: Uint8Array; remaining: number }): number {
  const inputCost = bytes.length * HEAP_BYTES_PER_INPUT_BYTE;
  if (inputCost > remaining) {
    return inputCost;
  }
  const elementLimit = Math.floor((remaining - inputCost) / HEAP_BYTES_PER_ELEMENT);
  return inputCost + countElementStarts({ bytes, limit: elementLimit }) * HEAP_BYTES_PER_ELEMENT;
}

// Every "<" counts as an element unless the byte after it opens an end tag, a comment, CDATA,
// a declaration or a processing instruction. Nothing about the name is examined, so no spelling
// the parser accepts can open an element this misses; a "<" inside a comment or CDATA counts
// too, which only errs on the side of refusing. Counting stops once the count passes the
// limit, where the exact total no longer matters.
function countElementStarts({ bytes, limit }: { bytes: Uint8Array; limit: number }): number {
  let count = 0;
  for (let open = bytes.indexOf(LESS_THAN); open !== -1 && count <= limit; open = bytes.indexOf(LESS_THAN, open + 1)) {
    if (!NON_ELEMENT_MARKERS.has(bytes[open + 1])) {
      count++;
    }
  }
  return count;
}

function withWorkbookPartPrepared(parts: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const workbookXml = parts[WORKBOOK_PART];
  if (isNil(workbookXml)) {
    return parts;
  }
  if (holdsSkippedCharacter(workbookXml)) {
    throw unreadableWorkbookError(`${WORKBOOK_PART} contains characters that XML does not allow.`);
  }
  const decoded = tryCatchSync(() => new TextDecoder('utf-8', { fatal: true }).decode(workbookXml));
  if (decoded.error !== null) {
    throw unreadableWorkbookError(`${WORKBOOK_PART} is not valid UTF-8 text.`);
  }
  const prepared = decoded.data
    .replace(DATE_1904_TRUE_ATTRIBUTE, (_match, attributeStart: string, quote: string) => `${attributeStart}${quote}1${quote}`)
    .replace(DEFINED_NAMES_TAG, (_match, slash: string, prefix: string) => `<${slash}${prefix}${IGNORED_DEFINED_NAMES_TAG}`);
  if (REMAINING_DEFINED_NAMES_TAG.test(prepared)) {
    throw unreadableWorkbookError(`${WORKBOOK_PART} contains defined names in a form this action cannot skip.`);
  }
  return { ...parts, [WORKBOOK_PART]: Buffer.from(prepared, 'utf8') };
}

function holdsSkippedCharacter(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buffer.some((byte) => SKIPPED_CONTROL_BYTES.has(byte)) || SKIPPED_NON_CHARACTERS.some((sequence) => buffer.includes(sequence));
}

function unreadableWorkbookError(reason: string): Error {
  return new Error(`The file could not be read as an Excel workbook (.xlsx): ${reason}`);
}

function worksheetToCsv({ worksheet, delimiter, date1904, maxFields }: WorksheetToCsvParams): string {
  const range = findUsedRange(worksheet);
  if (isNil(range)) {
    return '';
  }
  const height = range.bottom - range.top + 1;
  const width = range.right - range.left + 1;
  if (height * width > maxFields) {
    throw new Error(
      `Sheet "${worksheet.name}" is too large to convert: its used range is ${height} rows by ${width} columns, ` +
      `more than the ${maxFields.toLocaleString('en-US')} cells this workbook leaves room for. ` +
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
        .map((cell) => toCsvField({ text: cellText({ cell, numberFormats, date1904 }), delimiter }))
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

function cellText({ cell, numberFormats, date1904 }: { cell: Cell | undefined; numberFormats: ReadonlySet<string>; date1904: boolean }): string {
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

type WorksheetToCsvParams = {
  worksheet: Worksheet;
  delimiter: string;
  date1904: boolean;
  maxFields: number;
};

type EscapeDecoding = 'all' | 'lower-case';

type ValueTextParams = {
  value: unknown;
  numberFormat: string;
  escapes: EscapeDecoding;
  date1904: boolean;
};
