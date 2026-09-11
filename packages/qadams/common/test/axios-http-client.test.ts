import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
