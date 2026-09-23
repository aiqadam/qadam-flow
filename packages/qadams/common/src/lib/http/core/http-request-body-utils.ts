import { isNil } from '@aiqadam/shared';
import mime from 'mime-types';
import { HttpHeader } from './http-header';
import type { HttpHeaders } from './http-headers';
import { MediaType } from './media-type';

export const httpRequestBodyUtils = {
  descriptions: {
    raw: 'Sent exactly as typed. Content-Type is text/plain unless you set a Content-Type header.',
    binary:
      "The file's bytes are sent as the request body, unchanged. Content-Type is taken from your Content-Type header if you set one, otherwise from the file's extension, otherwise application/octet-stream.",
  },
  // The text goes out as bytes rather than as a string: axios JSON-encodes a string body whenever
  // the Content-Type is application/json, which would quote a raw body the user typed verbatim.
  raw({ text, headers }: { text: unknown; headers: HttpHeaders }): PreparedRequestBody {
    return {
      body: Buffer.from(toRawText({ text }), 'utf8'),
      headers: withSingleContentType({ headers, fallback: MediaType.TEXT_PLAIN }),
    };
  },
  binary({ file, headers }: { file: unknown; headers: HttpHeaders }): PreparedRequestBody {
    if (!isBinaryBodyFile(file)) {
      throw new Error('Binary body requires a file. Provide a file URL, a base64 data URI, or a file from a previous step.');
    }
    return {
      body: file.data,
      headers: withSingleContentType({ headers, fallback: contentTypeFromFile({ file }) }),
    };
  },
};

const toRawText = ({ text }: { text: unknown }): string => {
  if (typeof text === 'string') {
    return text;
  }
  if (isNil(text)) {
    return '';
  }
  // Mirrors the engine's text processor, so a non-string value reads the same as it would have
  // if the engine had coerced it before handing it over.
  return typeof text === 'object' ? JSON.stringify(text) : String(text);
};

const CONTENT_TYPE_HEADER = HttpHeader.CONTENT_TYPE.toLowerCase();

const isContentTypeKey = (key: string): boolean => key.toLowerCase() === CONTENT_TYPE_HEADER;

const findContentType = ({ headers }: { headers: HttpHeaders }): string | undefined => {
  const values = Object.entries(headers)
    .filter(([key]) => isContentTypeKey(key))
    .map(([, value]) => (Array.isArray(value) ? value[0] : value))
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  // axios lets the last case-variant of a header win, so the last one here is the one it would send.
  return values[values.length - 1];
};

// The base client adds its own `Content-Type: application/json` default under the canonical key;
// leaving a differently-cased user key beside it would put two Content-Type headers on the request.
const withSingleContentType = ({ headers, fallback }: { headers: HttpHeaders; fallback: string }): HttpHeaders => {
  const contentType = findContentType({ headers }) ?? fallback;
  const withoutContentType = Object.fromEntries(Object.entries(headers).filter(([key]) => !isContentTypeKey(key)));
  return { ...withoutContentType, [HttpHeader.CONTENT_TYPE]: contentType };
};

const contentTypeFromFile = ({ file }: { file: BinaryBodyFile }): string => {
  const fromFilename = mime.lookup(file.filename);
  if (fromFilename) {
    return fromFilename;
  }
  const fromExtension = isNil(file.extension) ? false : mime.lookup(file.extension);
  return fromExtension || MediaType.APPLICATION_OCTET_STREAM;
};

// Structural rather than `instanceof ApFile`: the engine builds the file with its own copy of the
// framework, which need not be the copy this package resolves.
const isBinaryBodyFile = (value: unknown): value is BinaryBodyFile =>
  typeof value === 'object' &&
  value !== null &&
  'data' in value &&
  Buffer.isBuffer(value.data) &&
  'filename' in value &&
  typeof value.filename === 'string' &&
  (!('extension' in value) || isNil(value.extension) || typeof value.extension === 'string');

type BinaryBodyFile = {
  filename: string;
  data: Buffer;
  extension?: string | null;
};

export type PreparedRequestBody = {
  body: Buffer;
  headers: HttpHeaders;
};
