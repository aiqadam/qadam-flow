import { ApFile } from '@aiqadam/qadams-framework';
import { describe, expect, it } from 'vitest';
import { httpRequestBodyUtils } from '../src/lib/http/core/http-request-body-utils';

describe('httpRequestBodyUtils.binary', () => {
  it('returns the file buffer itself as the body', () => {
    const data = Buffer.from([1, 2, 3]);

    const prepared = httpRequestBodyUtils.binary({ file: new ApFile('a.bin', data), headers: {} });

    expect(prepared.body).toBe(data);
  });

  it('derives the Content-Type from the filename', () => {
    const prepared = httpRequestBodyUtils.binary({ file: new ApFile('photo.JPG', Buffer.from('x')), headers: {} });

    expect(prepared.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('falls back to the extension when the filename carries none', () => {
    const prepared = httpRequestBodyUtils.binary({ file: new ApFile('unknown', Buffer.from('x'), 'pdf'), headers: {} });

    expect(prepared.headers).toEqual({ 'Content-Type': 'application/pdf' });
  });

  it('falls back to application/octet-stream when nothing identifies the type', () => {
    const prepared = httpRequestBodyUtils.binary({ file: new ApFile('blob', Buffer.from('x')), headers: {} });

    expect(prepared.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
  });

  it('accepts a plain file-shaped object, not only an ApFile instance', () => {
    const data = Buffer.from('x');

    const prepared = httpRequestBodyUtils.binary({ file: { filename: 'a.csv', data }, headers: {} });

    expect(prepared.body).toBe(data);
    expect(prepared.headers).toEqual({ 'Content-Type': 'text/csv' });
  });

  it.each([null, undefined, 'a string', { filename: 'a.txt', data: 'not a buffer' }])(
    'throws on a value that is not a file (%s)',
    (file) => {
      expect(() => httpRequestBodyUtils.binary({ file, headers: {} })).toThrow('Binary body requires a file');
    }
  );
});

describe('httpRequestBodyUtils content-type selection', () => {
  it('keeps a user Content-Type under any casing and collapses it to one canonical header', () => {
    const prepared = httpRequestBodyUtils.raw({
      text: 'x',
      headers: { 'CONTENT-type': 'application/xml', Authorization: 'Bearer t' },
    });

    expect(prepared.headers).toEqual({ 'Content-Type': 'application/xml', Authorization: 'Bearer t' });
  });

  it('lets the last case-variant win, as axios would', () => {
    const prepared = httpRequestBodyUtils.raw({
      text: 'x',
      headers: { 'content-type': 'text/csv', 'Content-Type': 'application/json' },
    });

    expect(prepared.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('reads the first value of an array-valued header', () => {
    const prepared = httpRequestBodyUtils.raw({ text: 'x', headers: { 'content-type': ['text/html', 'text/csv'] } });

    expect(prepared.headers).toEqual({ 'Content-Type': 'text/html' });
  });

  it('treats a blank Content-Type as unset', () => {
    const prepared = httpRequestBodyUtils.raw({ text: 'x', headers: { 'content-type': '  ' } });

    expect(prepared.headers).toEqual({ 'Content-Type': 'text/plain' });
  });

  it('does not mutate the headers it was given', () => {
    const headers = { 'content-type': 'application/json' };

    httpRequestBodyUtils.raw({ text: 'x', headers });

    expect(headers).toEqual({ 'content-type': 'application/json' });
  });
});

describe('httpRequestBodyUtils.raw', () => {
  it('encodes the text as UTF-8 bytes, unchanged', () => {
    const prepared = httpRequestBodyUtils.raw({ text: '  héllo "world"\n', headers: {} });

    expect(prepared.body.toString('utf8')).toBe('  héllo "world"\n');
    expect(prepared.headers).toEqual({ 'Content-Type': 'text/plain' });
  });

  it.each([
    [undefined, ''],
    [42, '42'],
    [{ a: 1 }, '{"a":1}'],
  ])('coerces a non-string value %s the way the engine text processor does', (text, expected) => {
    expect(httpRequestBodyUtils.raw({ text, headers: {} }).body.toString('utf8')).toBe(expected);
  });
});
