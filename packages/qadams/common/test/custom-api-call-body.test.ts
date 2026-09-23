import { ApFile, createMockActionContext } from '@aiqadam/qadams-framework';
import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomApiCallAction } from '../src/lib/helpers';
import { AxiosHttpClient } from '../src/lib/http/axios/axios-http-client';
import { httpClient } from '../src/lib/http/core/http-client';
import { HttpMethod } from '../src/lib/http/core/http-method';

const customApiCall = createCustomApiCallAction({
  baseUrl: () => 'https://api.example.com',
});

// Mautic and PagerDuty map their connection to headers that include a Content-Type.
const customApiCallWithConnectionContentType = createCustomApiCallAction({
  baseUrl: () => 'https://api.example.com',
  authMapping: async () => ({ 'Content-Type': 'application/json' }),
});

describe('createCustomApiCallAction request body', () => {
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
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7b, 0x22]);

    await run({ body_type: 'binary', body: { data: new ApFile('logo.png', bytes, 'png') } });

    expect(sent).toHaveLength(1);
    expect(Buffer.isBuffer(sent[0].data)).toBe(true);
    expect(sent[0].data).toEqual(bytes);
    expect(sent[0].contentTypes).toEqual(['image/png']);
  });

  it('falls back to application/octet-stream when the file has no recognisable extension', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02]);

    await run({ body_type: 'binary', body: { data: new ApFile('payload', bytes) } });

    expect(sent[0].data).toEqual(bytes);
    expect(sent[0].contentTypes).toEqual(['application/octet-stream']);
  });

  it("keeps the user's own Content-Type for a binary body, matched case-insensitively", async () => {
    const bytes = Buffer.from('%PDF-1.7 not really json');

    await run({
      body_type: 'binary',
      body: { data: new ApFile('report.pdf', bytes, 'pdf') },
      headers: { 'content-TYPE': 'application/vnd.custom+binary' },
    });

    expect(sent[0].data).toEqual(bytes);
    expect(sent[0].contentTypes).toEqual(['application/vnd.custom+binary']);
  });

  it('rejects a binary body that is not a file', async () => {
    await expect(run({ body_type: 'binary', body: { data: 'not a file' } })).rejects.toThrow(
      'Binary body requires a file'
    );
    expect(sent).toHaveLength(0);
  });

  it('sends a raw body unquoted as text/plain when no Content-Type is set', async () => {
    await run({ body_type: 'raw', body: { data: 'hello, world' } });

    expect(bodyText({ request: sent[0] })).toBe('hello, world');
    expect(sent[0].contentTypes).toEqual(['text/plain']);
  });

  it("keeps the user's application/json Content-Type for a raw body and still does not re-encode it", async () => {
    await run({
      body_type: 'raw',
      body: { data: 'not { valid json' },
      headers: { 'content-type': 'application/json' },
    });

    expect(bodyText({ request: sent[0] })).toBe('not { valid json');
    expect(sent[0].contentTypes).toEqual(['application/json']);
  });

  it('still JSON-encodes a json body', async () => {
    await run({ body_type: 'json', body: { data: { name: 'Ada', tags: ['x'] } } });

    expect(sent[0].data).toBe('{"name":"Ada","tags":["x"]}');
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

  it.each([
    ['raw', { data: 'a,b\n1,2' }],
    ['binary', { data: new ApFile('rows.csv', Buffer.from('a,b\n1,2'), 'csv') }],
  ])(
    "lets a connection's own Content-Type override the user's for a %s body, as one header",
    async (body_type, body) => {
      await run({
        action: customApiCallWithConnectionContentType,
        body_type,
        body,
        headers: { 'content-type': 'text/csv' },
      });

      expect(sent[0].contentTypes).toEqual(['application/json']);
      expect(bodyText({ request: sent[0] })).toBe('a,b\n1,2');
    }
  );
});

async function run({
  action = customApiCall,
  body_type,
  body,
  headers = {},
}: {
  action?: typeof customApiCall;
  body_type: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<unknown> {
  return action.run(
    createMockActionContext<typeof action.props>({
      propsValue: {
        url: { url: 'https://api.example.com/upload' },
        method: HttpMethod.POST,
        headers,
        queryParams: {},
        body_type,
        body,
        response_is_binary: false,
        failsafe: false,
        timeout: undefined,
        followRedirects: false,
      },
    })
  );
}

function toSentRequest({ config }: { config: AxiosRequestConfig }): SentRequest {
  const headerEntries = Object.entries(config.headers ?? {});
  return {
    data: config.data,
    contentTypes: headerEntries
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
