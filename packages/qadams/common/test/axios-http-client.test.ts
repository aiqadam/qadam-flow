import { inspect } from 'node:util';
import { ERROR_MESSAGES_TO_REDACT, formatQadamError } from '@aiqadam/shared';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosHttpClient } from '../src/lib/http/axios/axios-http-client';
import { HttpError } from '../src/lib/http/core/http-error';
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
    // Several cases below silence `console.error`; without this each adds a spy that outlives it, and
    // the next test to assert on console output reads through a stack of them.
    vi.restoreAllMocks();
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

  // The engine redirects `console.error` and blanks any line matching `ERROR_MESSAGES_TO_REDACT`.
  // The guard had not matched since the two drifted apart: the list held `'HttpClient#sendRequest'`,
  // a string no line here emits, so the redaction never once ran and full request bodies went to
  // engine stderr. `HttpError` no longer carries the request at all, which is the real fix — but the
  // response body it still carries is the remote server's, and a failing token endpoint is perfectly
  // capable of echoing a credential back, so the guard stays and so does this test.
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

  // The body reached four surfaces, and the redaction above only ever covered the first: engine
  // stderr; the run's step *output*, since a `failsafe` action returns `errorMessage()` verbatim;
  // for every non-failsafe failure, the step's `errorMessage` and the run's `failedStep.message`,
  // because the engine formats a thrown error with `util.inspect` — which prints the message *and*
  // every own enumerable property, so the body appeared there twice over; and the fourth, covered
  // by the last test in this file.
  //
  // Asserted as "this string appears in no rendering of the error" rather than against a shape. A
  // shape assertion passes the moment someone reintroduces the body under a different key, and
  // `inspect` — the surface that was missed — is not a shape anything would think to assert on.
  it.each([
    ['message', (e: HttpError) => e.message],
    ['inspect', (e: HttpError) => inspect(e)],
    ['own enumerable properties', (e: HttpError) => JSON.stringify(Object.entries(e))],
    ['errorMessage()', (e: HttpError) => JSON.stringify(e.errorMessage())],
    ['JSON.stringify', (e: HttpError) => JSON.stringify(e)],
  ])('does not carry the request body into %s', async (_surface, render) => {
    const thrown = await sendFailingRequest();

    expect(render(thrown)).not.toContain(SECRET_IN_BODY);
  });

  // The other half of the fix: dropping the request must not take the response with it. The response
  // is what a failing step is diagnosed from, and it is the server's own words rather than the
  // credentials we sent it.
  it('still carries the response status and body', async () => {
    const thrown = await sendFailingRequest();

    expect(thrown.response).toEqual({ status: 429, body: RESPONSE_BODY });
    expect(thrown.errorMessage()).toEqual({
      response: { status: 429, body: RESPONSE_BODY },
    });
  });

  // The fourth surface, and the one with no compile error to announce it. The engine persists a
  // failed step as `formatQadamError(error, { raw: inspect(error) })`, and `extractHttpDetails`
  // reads `error['request']` by index rather than through the class, lifting `request.body` into a
  // first-class `requestBody` field of the stored error — the one the *Copy AI prompt* button sends
  // to a model. (Technical Details shows `raw`, the `inspect` string, which the case above covers.)
  // Because that read is duck-typed, removing the getter satisfies it silently; nothing would fail
  // if a later change handed the body back under the same key. Asserted through the real function
  // rather than by reasoning about it.
  it('does not reach the persisted error the engine builds from it', async () => {
    const thrown = await sendFailingRequest();

    const persisted = formatQadamError(thrown, { raw: inspect(thrown) });

    expect(JSON.stringify(persisted)).not.toContain(SECRET_IN_BODY);
    // The key itself survives as `undefined` — `extractHttpDetails` spreads a fixed set of keys
    // whether or not it found values for them — and `JSON.stringify` drops it. The value is what
    // matters, and what a reintroduced getter would change.
    expect(persisted.requestBody).toBeUndefined();
    expect(persisted.requestUrl).toBeUndefined();
    expect(persisted.responseBody).toEqual(RESPONSE_BODY);
  });
});

async function sendFailingRequest(): Promise<HttpError> {
  const failing = axios.create({
    adapter: async (config) => {
      throw new axios.AxiosError('boom', 'ERR', config, undefined, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {},
        config,
        data: RESPONSE_BODY,
      });
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  return new AxiosHttpClient()
    .sendRequest(
      {
        method: HttpMethod.POST,
        url: 'https://example.com/',
        body: { client_secret: SECRET_IN_BODY },
      },
      failing
    )
    .then(() => {
      throw new Error('sendRequest resolved; this helper exists to produce a failure');
    })
    .catch((error: unknown) => {
      if (!(error instanceof HttpError)) throw error;
      return error;
    });
}

// Distinctive enough that a match in any rendering is unambiguous, rather than a substring that
// could plausibly have come from somewhere else.
const SECRET_IN_BODY = 'do-not-leak-me-9f3c1a';
const RESPONSE_BODY = { error: 'rate limited' };
