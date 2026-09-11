import { QadamEventPullOutcome } from '@aiqadam/qadams-framework';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramTransport, telegramEventPuller } from '../src/lib/long-polling';

const respondWith = (params: { status?: number, body: unknown }) => {
  const { status = 200, body } = params;
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const pull = (cursor?: string, config: unknown = { transport: TelegramTransport.LONG_POLLING }) =>
  telegramEventPuller.waitForEvents({
    auth: { secret_text: 'token' },
    config,
    cursor,
    signal: new AbortController().signal,
  });

describe('telegramEventPuller.isEnabledFor', () => {
  it('only claims triggers whose transport prop asks for long polling', () => {
    expect(telegramEventPuller.isEnabledFor({ config: { transport: 'long_polling' } })).toBe(true);
    expect(telegramEventPuller.isEnabledFor({ config: { transport: 'webhook' } })).toBe(false);
    expect(telegramEventPuller.isEnabledFor({ config: {} })).toBe(false);
    expect(telegramEventPuller.isEnabledFor({ config: undefined })).toBe(false);
  });
});

describe('telegramEventPuller.waitForEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advances the cursor past the highest update_id in the batch', async () => {
    respondWith({ body: { ok: true, result: [{ update_id: 7 }, { update_id: 9 }, { update_id: 8 }] } });

    const result = await pull('5');

    expect(result).toEqual({
      outcome: QadamEventPullOutcome.EVENTS,
      events: [{ update_id: 7 }, { update_id: 9 }, { update_id: 8 }],
      nextCursor: '10',
    });
  });

  it('leaves the cursor untouched when the window closes empty', async () => {
    respondWith({ body: { ok: true, result: [] } });

    const result = await pull('5');

    expect(result).toEqual({
      outcome: QadamEventPullOutcome.EVENTS,
      events: [],
      nextCursor: '5',
    });
  });

  it('omits offset on the very first call and forwards the selected update types', async () => {
    const fetchMock = respondWith({ body: { ok: true, result: [] } });

    await pull(undefined, {
      transport: TelegramTransport.LONG_POLLING,
      update_types: ['message', 'callback_query', 42],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('offset')).toBeNull();
    expect(url.searchParams.get('timeout')).toBe('50');
    expect(url.searchParams.get('allowed_updates')).toBe('["message","callback_query"]');
  });

  it('treats a still-registered webhook as fatal', async () => {
    respondWith({
      status: 409,
      body: { ok: false, description: 'Conflict: can\'t use getUpdates method while webhook is active' },
    });

    const result = await pull('5');

    expect(result.outcome).toBe(QadamEventPullOutcome.FATAL);
  });

  it('treats a competing getUpdates call as retryable, not fatal', async () => {
    respondWith({
      status: 409,
      body: { ok: false, description: 'Conflict: terminated by other getUpdates request' },
    });

    const result = await pull('5');

    expect(result.outcome).toBe(QadamEventPullOutcome.RETRYABLE);
  });

  it('treats a revoked token as fatal', async () => {
    respondWith({ status: 401, body: { ok: false, description: 'Unauthorized' } });

    const result = await pull('5');

    expect(result.outcome).toBe(QadamEventPullOutcome.FATAL);
  });

  it('surfaces retry_after as a retryable delay', async () => {
    respondWith({
      status: 429,
      body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } },
    });

    const result = await pull('5');

    expect(result).toEqual({
      outcome: QadamEventPullOutcome.RETRYABLE,
      reason: 'Telegram getUpdates failed with 429: Too Many Requests',
      retryAfterSeconds: 12,
    });
  });

  it('treats a server error as retryable', async () => {
    respondWith({ status: 502, body: {} });

    const result = await pull('5');

    expect(result.outcome).toBe(QadamEventPullOutcome.RETRYABLE);
  });

  it('treats an unreachable endpoint as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    const result = await pull('5');

    expect(result.outcome).toBe(QadamEventPullOutcome.RETRYABLE);
  });

  it('refuses a connection value that is not a bot token', async () => {
    const fetchMock = respondWith({ body: { ok: true, result: [] } });

    const result = await telegramEventPuller.waitForEvents({
      auth: { access_token: 'nope' },
      config: {},
      cursor: undefined,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe(QadamEventPullOutcome.FATAL);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('telegramEventPuller.credentialKey', () => {
  it('identifies the bot by its id, not by the whole token', () => {
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: '123456789:AAHhk-secret' } })).toBe(
      '123456789'
    );
  });

  // The point of the key: the host locks on it, so two *different* connections holding one bot —
  // which is what Telegram counts as one consumer — must not end up with two locks.
  it('gives two connections on the same bot one identity, and different bots different ones', () => {
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: '777:first-copy' } })).toBe(
      telegramEventPuller.credentialKey({ auth: { secret_text: '777:second-copy' } })
    );
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: '777:AAA' } })).not.toBe(
      telegramEventPuller.credentialKey({ auth: { secret_text: '778:AAA' } })
    );
  });

  it('survives the token being regenerated for the same bot', () => {
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: '777:old' } })).toBe(
      telegramEventPuller.credentialKey({ auth: { secret_text: '777:new' } })
    );
  });

  it('does not leak the secret half of the token', () => {
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: '777:AAHhk-secret' } })).not.toContain(
      'AAHhk-secret'
    );
  });

  it('returns undefined for a value that is not a bot token', () => {
    expect(telegramEventPuller.credentialKey({ auth: { access_token: 'nope' } })).toBeUndefined();
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: ':no-id' } })).toBeUndefined();
  });
});

describe('telegramEventPuller.credentialKey rejects anything that is not a bot token', () => {
  // The value becomes a Redis key, so a token missing its separator must not be returned whole.
  it('refuses a value with no separator instead of returning the secret', () => {
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: 'AAHhk-just-the-secret' } })).toBeUndefined();
  });

  it('refuses a non-numeric bot id', () => {
    expect(telegramEventPuller.credentialKey({ auth: { secret_text: 'notanid:AAHhk' } })).toBeUndefined();
  });
});
