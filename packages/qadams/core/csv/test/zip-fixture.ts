import { crc32, deflateRawSync } from 'node:zlib';

// Writes a ZIP archive part by part, so a test can state exactly which parts a workbook holds
// and what its headers declare.
export const zipFixture = {
  build(entries: ZipFixtureEntry[]): Buffer {
    const encoded = entries.map(encodeEntry);
    const { locals, centrals } = encoded.reduce<{ locals: Buffer[]; centrals: Buffer[]; offset: number }>(
      (acc, entry) => {
        const local = Buffer.concat([localHeader(entry), entry.name, entry.payload, dataDescriptor(entry)]);
        return {
          locals: [...acc.locals, local],
          centrals: [...acc.centrals, centralHeader({ entry, localOffset: acc.offset })],
          offset: acc.offset + local.length,
        };
      },
      { locals: [], centrals: [], offset: 0 }
    );
    const directory = Buffer.concat(centrals);
    const directoryOffset = locals.reduce((total, local) => total + local.length, 0);
    return Buffer.concat([...locals, directory, endOfDirectory({ count: entries.length, directory, directoryOffset })]);
  },

  // The smallest set of parts the parser accepts as a one-sheet workbook named "Data".
  minimalWorkbookParts({ sheetData, workbookExtra = '', sheetExtra = '' }: MinimalWorkbookOptions): ZipFixtureEntry[] {
    return [
      {
        name: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      },
      {
        name: '_rels/.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      },
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${SPREADSHEET_NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>${workbookExtra}</workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${SPREADSHEET_NS}><sheetData>${sheetData}</sheetData>${sheetExtra}</worksheet>`,
      },
    ];
  },
};

const SPREADSHEET_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const FLAG_DATA_DESCRIPTOR = 0x8;
const FLAG_UTF8_NAMES = 0x800;
const UINT32_SENTINEL = 0xffffffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

function encodeEntry(entry: ZipFixtureEntry): EncodedEntry {
  const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
  const compress = entry.compress ?? true;
  return {
    name: Buffer.from(entry.name, 'utf8'),
    payload: compress ? deflateRawSync(data) : data,
    method: entry.method ?? (compress ? 8 : 0),
    flags: FLAG_UTF8_NAMES | (entry.flags ?? 0) | (entry.dataDescriptor === true ? FLAG_DATA_DESCRIPTOR : 0),
    crc: crc32(data),
    declaredSize: entry.declaredSize ?? data.length,
    zip64: entry.zip64 === true,
    dataDescriptor: entry.dataDescriptor === true,
  };
}

// With a data descriptor the local header leaves CRC and sizes zero; the central directory and
// the descriptor after the data carry them.
function localHeader(entry: EncodedEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  if (!entry.dataDescriptor) {
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.payload.length, 18);
    header.writeUInt32LE(entry.declaredSize, 22);
  }
  header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function dataDescriptor(entry: EncodedEntry): Buffer {
  if (!entry.dataDescriptor) {
    return Buffer.alloc(0);
  }
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(entry.crc, 4);
  descriptor.writeUInt32LE(entry.payload.length, 8);
  descriptor.writeUInt32LE(entry.declaredSize, 12);
  return descriptor;
}

// A ZIP64 entry stores the 0xFFFFFFFF sentinel in both 32-bit size fields and the real sizes,
// uncompressed first, in a ZIP64 extra field.
function centralHeader({ entry, localOffset }: { entry: EncodedEntry; localOffset: number }): Buffer {
  const extra = entry.zip64 ? zip64Extra(entry) : Buffer.alloc(0);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 4);
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.zip64 ? UINT32_SENTINEL : entry.payload.length, 20);
  header.writeUInt32LE(entry.zip64 ? UINT32_SENTINEL : entry.declaredSize, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, entry.name, extra]);
}

function zip64Extra(entry: EncodedEntry): Buffer {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(entry.declaredSize), 4);
  extra.writeBigUInt64LE(BigInt(entry.payload.length), 12);
  return extra;
}

function endOfDirectory({ count, directory, directoryOffset }: { count: number; directory: Buffer; directoryOffset: number }): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directory.length, 12);
  record.writeUInt32LE(directoryOffset, 16);
  return record;
}

export type ZipFixtureEntry = {
  name: string;
  data: Uint8Array | string;
  compress?: boolean;
  declaredSize?: number;
  method?: number;
  flags?: number;
  zip64?: boolean;
  dataDescriptor?: boolean;
};

type MinimalWorkbookOptions = {
  sheetData: string;
  workbookExtra?: string;
  sheetExtra?: string;
};

type EncodedEntry = {
  name: Buffer;
  payload: Buffer;
  method: number;
  flags: number;
  crc: number;
  declaredSize: number;
  zip64: boolean;
  dataDescriptor: boolean;
};
