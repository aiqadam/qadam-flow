import { isUtf8 } from 'node:buffer';
import { createAction, Property, isNil, tryCatchSync } from '@aiqadam/qadams-framework';
import { conversionErrors } from '../common/conversion-errors';
import { conversionWorker } from '../common/conversion-worker';
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
    return conversionWorker.run({
      request: {
        parts: readWorkbookParts(Buffer.from(file.base64, 'base64')),
        sheetName: sheet_name ?? undefined,
        delimiter: delimiter_type,
      },
    });
  },
});

const LEGACY_OR_PROTECTED_MESSAGE =
  'This file is a legacy .xls (Excel 97-2003) workbook or a password-protected workbook, which cannot be read. ' +
  'Open it in Excel or Google Sheets, save it as an unprotected .xlsx file, and try again.';

const MEBIBYTE = 1024 * 1024;

// The parts are held in memory twice, once to check them here and once by the conversion
// worker, so their total is capped before any is inflated (from the sizes they declare). The
// parser holds at least about 5 bytes of heap for every byte of XML, plain whitespace included,
// and the CSV may not exceed 64 Mi characters (conversion-protocol.ts), so a workbook beyond
// this cap could not be converted within the worker's 512 MB anyway: the largest typical
// workbook that converts, about 80,000 rows by 10 columns, decompresses to about 35 MB.
const MAX_UNCOMPRESSED_WORKBOOK_MB = 64;

const WORKBOOK_PART = 'xl/workbook.xml';
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;

// The only parts the CSV is built from; the parser recognises worksheets by this path alone.
// Everything else (charts, drawings, media, comments, tables, pivot caches, themes, document
// properties, ...) is never inflated: some of it makes the parser fail without optional
// support installed, and all of it would cost memory for nothing.
const CONVERTED_PARTS = new Set(['_rels/.rels', WORKBOOK_PART, 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml']);

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

// Everything here is cheap and bounded by the size cap, so it runs before the conversion
// worker starts: a file that is not a workbook, or one this action would refuse anyway, never
// costs a worker.
function readWorkbookParts(buffer: Buffer): Record<string, Uint8Array> {
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
      maxUncompressedBytes: MAX_UNCOMPRESSED_WORKBOOK_MB * MEBIBYTE,
      skipPart: isUnusedPart,
    })
  );
  if (extracted.error !== null) {
    throw archiveErrorToUserError(extracted.error);
  }
  assertPartsAreUtf8(extracted.data);
  return withWorkbookPartPrepared(extracted.data);
}

function archiveErrorToUserError(error: Error): Error {
  if (!(error instanceof XlsxArchiveError)) {
    return conversionErrors.unreadableWorkbook(error.message);
  }
  switch (error.reason) {
    case 'too-large':
      return new Error(
        `The workbook is too large to convert: its contents exceed ${MAX_UNCOMPRESSED_WORKBOOK_MB} MB once decompressed. ` +
        'Split it into smaller workbooks, or delete unused sheets, and try again.'
      );
    case 'encrypted':
      return new Error(LEGACY_OR_PROTECTED_MESSAGE);
    case 'corrupt':
      return conversionErrors.unreadableWorkbook(error.message);
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
    throw conversionErrors.unreadableWorkbook(`${invalid} is not valid UTF-8 text.`);
  }
}

function withWorkbookPartPrepared(parts: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const workbookXml = parts[WORKBOOK_PART];
  if (isNil(workbookXml)) {
    return parts;
  }
  if (holdsSkippedCharacter(workbookXml)) {
    throw conversionErrors.unreadableWorkbook(`${WORKBOOK_PART} contains characters that XML does not allow.`);
  }
  const decoded = tryCatchSync(() => new TextDecoder('utf-8', { fatal: true }).decode(workbookXml));
  if (decoded.error !== null) {
    throw conversionErrors.unreadableWorkbook(`${WORKBOOK_PART} is not valid UTF-8 text.`);
  }
  const prepared = decoded.data
    .replace(DATE_1904_TRUE_ATTRIBUTE, (_match, attributeStart: string, quote: string) => `${attributeStart}${quote}1${quote}`)
    .replace(DEFINED_NAMES_TAG, (_match, slash: string, prefix: string) => `<${slash}${prefix}${IGNORED_DEFINED_NAMES_TAG}`);
  if (REMAINING_DEFINED_NAMES_TAG.test(prepared)) {
    throw conversionErrors.unreadableWorkbook(`${WORKBOOK_PART} contains defined names in a form this action cannot skip.`);
  }
  return { ...parts, [WORKBOOK_PART]: Buffer.from(prepared, 'utf8') };
}

function holdsSkippedCharacter(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buffer.some((byte) => SKIPPED_CONTROL_BYTES.has(byte)) || SKIPPED_NON_CHARACTERS.some((sequence) => buffer.includes(sequence));
}
