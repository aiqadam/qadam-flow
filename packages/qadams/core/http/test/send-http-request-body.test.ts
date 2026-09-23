import { AxiosHttpClient, HttpMethod, httpClient } from '@aiqadam/qadams-common';
import { ApFile, createMockActionContext } from '@aiqadam/qadams-framework';
import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpSendRequestAction } from '../src/lib/actions/send-http-request-action';

describe('Send HTTP request body', () => {
  let sent: SentRequest[] = [];

  beforeEach(() => {
    sent = [];
    // Route the shared client through a stub adapter: what the adapter receives is what axios would
    // put on the wire, after its own request transforms have run.
    const stubbedAxios = axios.create({
      adapter: async (config) => {
        sent = [...sent, toSentRequest({ config })];
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    const realClient = new AxiosHttpClient();
    vi.spyOn(httpClient, 'sendRequest').mockImplementation((request) =>
      realClient.sendRequest(request, stubbedAxios)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a binary file byte-for-byte with the MIME type of its extension', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x22]);

    const result = await run({ body_type: 'binary', body: { data: new ApFile('invoice.pdf', bytes, 'pdf') } });

    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(sent).toHaveLength(1);
    expect(Buffer.isBuffer(sent[0].data)).toBe(true);
    expect(sent[0].data).toEqual(bytes);
    expect(sent[0].contentTypes).toEqual(['application/pdf']);
  });

  it('falls back to application/octet-stream when the file has no recognisable extension', async () => {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    await run({ body_type: 'binary', body: { data: new ApFile('firmware', bytes) } });

    expect(sent[0].data).toEqual(bytes);
    expect(sent[0].contentTypes).toEqual(['application/octet-stream']);
  });

  it("keeps the user's own Content-Type for a binary body, matched case-insensitively", async () => {
    const bytes = Buffer.from('{"looks":"like json but is a file"}');

    await run({
      body_type: 'binary',
      body: { data: new ApFile('data.json', bytes, 'json') },
      headers: { 'CONTENT-TYPE': 'application/x-ndjson' },
    });

    expect(sent[0].data).toEqual(bytes);
    expect(sent[0].contentTypes).toEqual(['application/x-ndjson']);
  });

  it('sends a raw body unquoted as text/plain when no Content-Type is set', async () => {
    await run({ body_type: 'raw', body: { data: 'plain words, not JSON' } });

    expect(bodyText({ request: sent[0] })).toBe('plain words, not JSON');
    expect(sent[0].contentTypes).toEqual(['text/plain']);
  });

  it("keeps the user's application/json Content-Type for a raw body", async () => {
    await run({
      body_type: 'raw',
      body: { data: '{"id": 1}' },
      headers: { 'content-type': 'application/json' },
    });

    expect(bodyText({ request: sent[0] })).toBe('{"id": 1}');
    expect(sent[0].contentTypes).toEqual(['application/json']);
  });

  it('still JSON-encodes a json body', async () => {
    await run({ body_type: 'json', body: { data: { id: 1, name: 'Ada' } } });

    expect(sent[0].data).toBe('{"id":1,"name":"Ada"}');
    expect(sent[0].contentTypes).toEqual(['application/json']);
  });

  it('still sends form data as multipart', async () => {
    await run({
      body_type: 'form_data',
      body: {
        data: [
          { fieldName: 'note', fieldType: 'text', textFieldValue: 'hi' },
          { fieldName: 'upload', fieldType: 'file', fileFieldValue: new ApFile('a.txt', Buffer.from('abc'), 'txt') },
        ],
      },
    });

    expect(sent[0].data).toBeInstanceOf(FormData);
    expect(sent[0].contentTypes).toHaveLength(1);
    expect(sent[0].contentTypes[0]).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('rejects a binary body that is not a file before sending anything', async () => {
    await expect(run({ body_type: 'binary', body: { data: null } })).rejects.toThrow('Binary body requires a file');
    expect(sent).toHaveLength(0);
  });
});

async function run({
  body_type,
  body,
  headers = {},
}: {
  body_type: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<unknown> {
  return httpSendRequestAction.run(
    createMockActionContext({
      propsValue: {
        method: HttpMethod.POST,
        url: 'https://api.example.com/upload',
        headers,
        queryParams: {},
        authType: 'NONE',
        authFields: {},
        body_type,
        body,
        response_is_binary: false,
        use_proxy: false,
        proxy_settings: {},
        timeout: undefined,
        followRedirects: false,
        failureMode: 'continue_none',
      },
    })
  );
}

function toSentRequest({ config }: { config: AxiosRequestConfig }): SentRequest {
  return {
    data: config.data,
    contentTypes: Object.entries(config.headers ?? {})
      .filter(([key]) => key.toLowerCase() === 'content-type')
      .map(([, value]) => String(value)),
  };
}

function bodyText({ request }: { request: SentRequest }): string {
  const { data } = request;
  if (!Buffer.isBuffer(data)) {
    throw new Error(`expected the body to go out as bytes, got ${typeof data}`);
  }
  return data.toString('utf8');
}

type SentRequest = {
  data: unknown;
  contentTypes: string[];
};
