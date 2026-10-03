import { inflateRawSync } from 'node:zlib';
import { tryCatchSync } from '@aiqadam/shared';

// The workbook parser inflates every ZIP entry in full before it checks the entry's declared
// size, so a few kilobytes of deflate can expand to gigabytes inside it. The entries are
// inflated here instead, from the central directory, with the total capped and every entry
// held to the size it declares; the parser then only ever sees what this function returned.
// Skipped parts are never inflated and do not count towards the cap.
export const xlsxArchive = {
  extractEntries({ buffer, maxUncompressedBytes, skipPart }: ExtractEntriesParams): Record<string, Uint8Array> {
    const listed = readCentralDirectory(buffer).filter((entry) => !entry.name.endsWith('/'));
    const names = new Set(listed.map((entry) => entry.name));
    if (names.size !== listed.length) {
      throw new XlsxArchiveError({ reason: 'corrupt', detail: 'the archive lists the same part more than once' });
    }
    const entries = listed.filter((entry) => !skipPart(entry.name));
    const declaredTotal = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (declaredTotal > maxUncompressedBytes) {
      throw new XlsxArchiveError({ reason: 'too-large', detail: `it expands to ${declaredTotal} bytes` });
    }
    return Object.fromEntries(entries.map((entry) => [entry.name, inflateEntry({ buffer, entry })]));
  },
};

export class XlsxArchiveError extends Error {
  readonly reason: XlsxArchiveErrorReason;

  constructor({ reason, detail }: { reason: XlsxArchiveErrorReason; detail: string }) {
    super(detail);
    this.name = 'XlsxArchiveError';
    this.reason = reason;
  }
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_DIRECTORY_ENTRY_MIN_SIZE = 46;
const MAX_ARCHIVE_COMMENT_LENGTH = 0xffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UINT16_SENTINEL = 0xffff;
const UINT32_SENTINEL = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8_NAMES = 0x800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const endRecord = findEndOfCentralDirectory(buffer);
  const { entryCount, directoryOffset } = resolveDirectoryLocation({ buffer, endRecord });
  if (entryCount * CENTRAL_DIRECTORY_ENTRY_MIN_SIZE > buffer.length - directoryOffset) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'the ZIP directory lists more entries than it holds' });
  }
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    const { entry, nextOffset } = readDirectoryEntry({ buffer, offset });
    entries.push(entry);
    offset = nextOffset;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowestStart = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ARCHIVE_COMMENT_LENGTH);
  for (let offset = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= lowestStart; offset--) {
    if (
      buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset + END_OF_CENTRAL_DIRECTORY_SIZE + buffer.readUInt16LE(offset + 20) <= buffer.length
    ) {
      return offset;
    }
  }
  throw new XlsxArchiveError({ reason: 'corrupt', detail: 'the ZIP end-of-directory record is missing' });
}

function resolveDirectoryLocation({ buffer, endRecord }: { buffer: Buffer; endRecord: number }): DirectoryLocation {
  if (buffer.readUInt16LE(endRecord + 4) !== 0 || buffer.readUInt16LE(endRecord + 6) !== 0) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'multi-volume archives are not supported' });
  }
  const entryCount = buffer.readUInt16LE(endRecord + 10);
  const directoryOffset = buffer.readUInt32LE(endRecord + 16);
  if (entryCount !== UINT16_SENTINEL && directoryOffset !== UINT32_SENTINEL) {
    return { entryCount, directoryOffset: checkedOffset({ buffer, offset: directoryOffset }) };
  }
  const locator = endRecord - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'the ZIP64 directory locator is missing' });
  }
  const zip64Record = checkedOffset({ buffer, offset: readUInt64({ buffer, offset: locator + 8 }), length: 56 });
  if (buffer.readUInt32LE(zip64Record) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'the ZIP64 directory record is missing' });
  }
  return {
    entryCount: readUInt64({ buffer, offset: zip64Record + 32 }),
    directoryOffset: checkedOffset({ buffer, offset: readUInt64({ buffer, offset: zip64Record + 48 }) }),
  };
}

function readDirectoryEntry({ buffer, offset }: { buffer: Buffer; offset: number }): { entry: ZipEntry; nextOffset: number } {
  checkedOffset({ buffer, offset, length: CENTRAL_DIRECTORY_ENTRY_MIN_SIZE });
  if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'a ZIP directory entry is malformed' });
  }
  const flags = buffer.readUInt16LE(offset + 8);
  const method = buffer.readUInt16LE(offset + 10);
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const nameStart = offset + CENTRAL_DIRECTORY_ENTRY_MIN_SIZE;
  const extraStart = nameStart + nameLength;
  const nextOffset = extraStart + extraLength + commentLength;
  checkedOffset({ buffer, offset: nameStart, length: nextOffset - nameStart });
  const name = buffer.toString((flags & FLAG_UTF8_NAMES) !== 0 ? 'utf8' : 'latin1', nameStart, extraStart);
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new XlsxArchiveError({ reason: 'encrypted', detail: `part ${name} is encrypted` });
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: `part ${name} uses unsupported compression method ${method}` });
  }
  const sizes = applyZip64Extra({
    extra: buffer.subarray(extraStart, extraStart + extraLength),
    sizes: {
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      compressedSize: buffer.readUInt32LE(offset + 20),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    },
  });
  return { entry: { name, method, ...sizes }, nextOffset };
}

// A ZIP64 extra field carries, in this order, only those of the three values whose 32-bit
// field holds the 0xFFFFFFFF sentinel.
function applyZip64Extra({ extra, sizes }: { extra: Buffer; sizes: EntrySizes }): EntrySizes {
  const order: (keyof EntrySizes)[] = ['uncompressedSize', 'compressedSize', 'localHeaderOffset'];
  const overridden = order.filter((key) => sizes[key] === UINT32_SENTINEL);
  if (overridden.length === 0) {
    return sizes;
  }
  const zip64Field = findExtraField({ extra, id: ZIP64_EXTRA_FIELD_ID });
  if (zip64Field === null || zip64Field.length < overridden.length * 8) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'a ZIP64 size field is missing' });
  }
  return overridden.reduce<EntrySizes>(
    (current, key, index) => ({ ...current, [key]: readUInt64({ buffer: zip64Field, offset: index * 8 }) }),
    sizes
  );
}

function findExtraField({ extra, id }: { extra: Buffer; id: number }): Buffer | null {
  for (let offset = 0; offset + 4 <= extra.length; ) {
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    if (fieldId === id) {
      return extra.subarray(offset + 4, Math.min(extra.length, offset + 4 + fieldLength));
    }
    offset += 4 + fieldLength;
  }
  return null;
}

function inflateEntry({ buffer, entry }: { buffer: Buffer; entry: ZipEntry }): Uint8Array {
  const header = checkedOffset({ buffer, offset: entry.localHeaderOffset, length: 30 });
  if (buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: `part ${entry.name} has no local header` });
  }
  const dataStart = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  checkedOffset({ buffer, offset: dataStart, length: entry.compressedSize });
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === METHOD_STORED) {
    if (compressed.length !== entry.uncompressedSize) {
      throw sizeMismatch(entry);
    }
    return compressed;
  }
  // maxOutputLength makes zlib stop as soon as the output passes the declared size, so an
  // entry that lies about its size costs no more than the size it declared.
  const inflated = tryCatchSync(() =>
    inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) })
  );
  if (inflated.error !== null) {
    if (isBufferTooLargeError(inflated.error)) {
      throw sizeMismatch(entry);
    }
    throw new XlsxArchiveError({ reason: 'corrupt', detail: `part ${entry.name} could not be decompressed` });
  }
  if (inflated.data.length !== entry.uncompressedSize) {
    throw sizeMismatch(entry);
  }
  return inflated.data;
}

function isBufferTooLargeError(error: unknown): boolean {
  return error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
}

function sizeMismatch(entry: ZipEntry): XlsxArchiveError {
  return new XlsxArchiveError({ reason: 'corrupt', detail: `part ${entry.name} does not match the size it declares` });
}

function checkedOffset({ buffer, offset, length = 0 }: { buffer: Buffer; offset: number; length?: number }): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length) {
    throw new XlsxArchiveError({ reason: 'corrupt', detail: 'the archive is truncated' });
  }
  return offset;
}

function readUInt64({ buffer, offset }: { buffer: Buffer; offset: number }): number {
  checkedOffset({ buffer, offset, length: 8 });
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new XlsxArchiveError({ reason: 'too-large', detail: 'a ZIP64 size exceeds what can be read' });
  }
  return Number(value);
}

type ExtractEntriesParams = {
  buffer: Buffer;
  maxUncompressedBytes: number;
  skipPart: (name: string) => boolean;
};

type XlsxArchiveErrorReason = 'too-large' | 'corrupt' | 'encrypted';

type EntrySizes = {
  uncompressedSize: number;
  compressedSize: number;
  localHeaderOffset: number;
};

type ZipEntry = EntrySizes & {
  name: string;
  method: number;
};

type DirectoryLocation = {
  entryCount: number;
  directoryOffset: number;
};
