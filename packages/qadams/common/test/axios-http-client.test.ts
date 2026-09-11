import { ERROR_MESSAGES_TO_REDACT } from '@aiqadam/shared';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosHttpClient } from '../src/lib/http/axios/axios-http-client';
import { HttpMethod } from '../src/lib/http/core/http-method';

const stubbedAxios = axios.create({
  adapter: async (config) => ({
    data: { ok: true },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }),
});

describe('AxiosHttpClient', () => {
  let previousTlsSetting: string | undefined;

  beforeEach(() => {
    previousTlsSetting = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  afterEach(() => {
    if (previousTlsSetting === undefined) {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      return;
    }
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsSetting;
  });

  // NODE_TLS_REJECT_UNAUTHORIZED is read by tls.connect at connect time and is process-global, so
  // one qadam request used to turn off certificate verification for everything else in the same
  // process — including the server's own outbound TLS — and never turn it back on.
  it('does not disable TLS certificate verification process-wide', async () => {
    await new AxiosHttpClient().sendRequest(
      { method: HttpMethod.GET, url: 'https://example.com/' },
      stubbedAxios
    );

    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBeUndefined();
  });

  it('leaves an operator-set value alone', async () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';

    await new AxiosHttpClient().sendRequest(
      { method: HttpMethod.GET, url: 'https://example.com/' },
      stubbedAxios
    );

    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('1');
  });

  // The engine redirects `console.error` and blanks any line matching `ERROR_MESSAGES_TO_REDACT`,
  // because the `HttpError` logged below carries the *whole request body* — every secret a qadam
  // sends. The guard had not matched since the two drifted apart: the list held
  // `'HttpClient#sendRequest'`, a string no line here emits, so the redaction never once ran and
  // bodies went to engine stderr in full.
  //
  // Asserted against the string this client actually emits, not against the constant. A test
  // written from the constant passes whatever the log line says, which is the exact blind spot.
  it('emits a first argument the engine will recognise as redactable', async () => {
    const failing = axios.create({
      adapter: async () => {
        throw new axios.AxiosError('boom', 'ERR', undefined, {}, undefined);
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await new AxiosHttpClient()
      .sendRequest(
        { method: HttpMethod.POST, url: 'https://example.com/', body: { secret_token: 's3cret' } },
        failing
      )
      .catch(() => undefined);

    const first = logged.mock.calls[0]?.[0];
    logged.mockRestore();
    expect(typeof first).toBe('string');
    expect(ERROR_MESSAGES_TO_REDACT.some((m) => String(first).includes(m))).toBe(true);
  });
});
