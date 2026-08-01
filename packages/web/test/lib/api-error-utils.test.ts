import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import { apiErrorUtils } from '@/lib/api-error-utils';

const FALLBACK = 'Something went wrong, please try again later';

const axiosErrorWith = (data: unknown) => {
  const headers = new AxiosHeaders({
    authorization: 'Bearer super-secret-session-token',
  });
  const config = {
    headers,
    url: '/api/v1/ai-providers',
    method: 'post',
    data: JSON.stringify({ auth: { apiKey: 'sk-the-operators-api-key' } }),
  };
  return new AxiosError(
    'Request failed with status code 403',
    'ERR_BAD_REQUEST',
    config,
    {},
    {
      data,
      status: 403,
      statusText: 'Forbidden',
      headers: new AxiosHeaders(),
      config,
    },
  );
};

describe('apiErrorUtils.extractServerMessage', () => {
  it('prefers the sentence the server sent in params.message', () => {
    const message = apiErrorUtils.extractServerMessage({
      error: axiosErrorWith({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        params: {
          resource: 'custom_ai_providers',
          limit: 20,
          message: 'This platform has reached its limit of custom AI providers',
        },
      }),
      fallback: FALLBACK,
    });

    expect(message).toBe(
      'This platform has reached its limit of custom AI providers',
    );
  });

  it("uses Fastify's top-level message when there is one", () => {
    const message = apiErrorUtils.extractServerMessage({
      error: axiosErrorWith({ message: 'body/config must be an object' }),
      fallback: FALLBACK,
    });

    expect(message).toBe('body/config must be an object');
  });

  // The regression this file exists for. A QadamFlowError body is `{ code, params }`, and a params
  // shape with no `message` — RESOURCE_LIMIT_EXCEEDED's `{ resource, limit }` was one — used to
  // fall through to `JSON.stringify(error)`. An AxiosError serialises its `config`, and `config`
  // carries the Authorization header and the request body: the session bearer and the api key the
  // operator had just typed, rendered raw into the form's error message.
  it.each([
    ['params without a message', { code: 'RESOURCE_LIMIT_EXCEEDED', params: { resource: 'custom_ai_providers', limit: 20 } }],
    ['a blank message', { params: { message: '   ' } }],
    ['a non-string message', { params: { message: { nested: true } } }],
    ['no body at all', undefined],
  ])('falls back to the caller sentence for %s, and never leaks the request', (_label, data) => {
    const error = axiosErrorWith(data);

    const message = apiErrorUtils.extractServerMessage({
      error,
      fallback: FALLBACK,
    });

    expect(message).toBe(FALLBACK);
    expect(message).not.toContain('super-secret-session-token');
    expect(message).not.toContain('sk-the-operators-api-key');
  });

  it('falls back for anything that is not an axios error', () => {
    expect(
      apiErrorUtils.extractServerMessage({
        error: new Error('boom'),
        fallback: FALLBACK,
      }),
    ).toBe(FALLBACK);
  });
});
