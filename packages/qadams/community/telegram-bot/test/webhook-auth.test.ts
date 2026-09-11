import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, httpClient: { sendRequest } };
});

const { telegramWebhookAuth } = await import('../src/lib/webhook-auth');
const { telegramCommons } = await import('../src/lib/common');

const BOT_TOKEN = '7777777:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WEBHOOK_URL = 'https://flow.example.org/api/v1/webhooks/flow1';

const secret = telegramWebhookAuth.secretFor({
  botToken: BOT_TOKEN,
  webhookUrl: WEBHOOK_URL,
});

const headersWith = (value: string): Record<string, string> => ({
  'content-type': 'application/json',
  [telegramWebhookAuth.HEADER]: value,
});

/**
 * The webhook endpoint is public and the flow id in its URL is the only thing protecting it, and a
 * flow id leaks easily. Telegram's answer is `secret_token`, echoed back on every delivery — so
 * these cases are what stands between a flow and a forged update naming any chat it likes.
 */
describe('telegram webhook authenticity', () => {
  it('accepts the secret Telegram was given', () => {
    expect(
      telegramWebhookAuth.isAuthentic({
        headers: headersWith(secret),
        expected: secret,
      })
    ).toBe(true);
  });

  it('rejects a request with no header at all — the shape a forgery takes', () => {
    expect(
      telegramWebhookAuth.isAuthentic({
        headers: { 'content-type': 'application/json' },
        expected: secret,
      })
    ).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(
      telegramWebhookAuth.isAuthentic({
        headers: headersWith('not-the-secret'),
        expected: secret,
      })
    ).toBe(false);
  });

  // `timingSafeEqual` throws when the buffers differ in length, and an exception escaping here
  // would read as a server error rather than a rejection.
  it('rejects a longer and a shorter secret without throwing', () => {
    expect(
      telegramWebhookAuth.isAuthentic({
        headers: headersWith(`${secret}x`),
        expected: secret,
      })
    ).toBe(false);
    expect(
      telegramWebhookAuth.isAuthentic({
        headers: headersWith(secret.slice(0, -1)),
        expected: secret,
      })
    ).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(
      telegramWebhookAuth.isAuthentic({ headers: headersWith(''), expected: secret })
    ).toBe(false);
  });
});

describe('the derived secret', () => {
  // Derived rather than stored, so both sides can recompute it: `connection.metadata` is
  // unencrypted and the connection value is the credential itself, so neither is a home for it.
  it('is stable for the same bot and flow', () => {
    expect(
      telegramWebhookAuth.secretFor({ botToken: BOT_TOKEN, webhookUrl: WEBHOOK_URL })
    ).toBe(secret);
  });

  // Otherwise one flow's secret would authenticate a forgery aimed at another.
  it('differs per flow, because the webhook URL does', () => {
    expect(
      telegramWebhookAuth.secretFor({
        botToken: BOT_TOKEN,
        webhookUrl: 'https://flow.example.org/api/v1/webhooks/flow2',
      })
    ).not.toBe(secret);
  });

  // Rotating the token must rotate the secret; the next enable re-registers it.
  it('changes when the token does', () => {
    expect(
      telegramWebhookAuth.secretFor({
        botToken: '7777777:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        webhookUrl: WEBHOOK_URL,
      })
    ).not.toBe(secret);
  });

  // Telegram accepts 1–256 characters of A-Z, a-z, 0-9, `_` and `-` only. A secret outside that
  // set is rejected by `setWebhook`, which would leave the flow with no webhook at all.
  it('uses only the alphabet Telegram accepts, at a length it allows', () => {
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(1);
    expect(secret.length).toBeLessThanOrEqual(256);
  });

  // A golden vector. Self-consistency within a run cannot catch a change to the derivation, and
  // such a change silently invalidates every webhook already registered with Telegram: the flows
  // keep running, receive nothing, and say nothing. If this test fails, the derivation moved and
  // every Telegram connection has to be re-enabled.
  it('matches the value already registered with Telegram for this input', () => {
    expect(
      telegramWebhookAuth.secretFor({
        botToken: '7777777:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        webhookUrl: 'https://flow.example.org/api/v1/webhooks/flow1',
      })
    ).toBe('zPLL18k1NjT1_BCQxCVhle__yF6dk2rqjV-H730NOwQ');
  });

  // It is keyed by the token, so it must not be derivable from public material alone.
  it('does not contain the bot token', () => {
    expect(secret).not.toContain(BOT_TOKEN);
    expect(secret).not.toContain(BOT_TOKEN.split(':')[1]);
  });
});

/**
 * Reported from a running stand: enabling a webhook flow against a non-HTTPS URL fails, and the
 * platform shows the failure with its request body — which now carries `secret_token`. Anyone who
 * can enable the flow would read the secret out of that dialog, including someone who cannot see
 * the bot token and so could not otherwise derive it. The secret is what proves an update came from
 * Telegram, so leaking it hands away exactly what it protects.
 */
/**
 * The comparison that decides whether Telegram is delivering to *this* endpoint. Full-string
 * equality wedged a flow forever if an operator ever changed the instance's public URL — it could
 * never match, so the secret was never installed and every update paid a `getWebhookInfo`. Path
 * equality survives that while still separating production from the public `/test` route, which is
 * the distinction that must not blur: matching there would let an anonymous request re-point the
 * bot at a URL that never runs the flow.
 */
describe('isSameEndpoint', () => {
  it('matches the same flow through a different host', () => {
    expect(
      telegramWebhookAuth.isSameEndpoint({
        registered: 'https://old-host.example.org/api/v1/webhooks/flow1',
        webhookUrl: 'https://new-host.example.org/api/v1/webhooks/flow1',
      })
    ).toBe(true);
  });

  it('does not match the public test route', () => {
    expect(
      telegramWebhookAuth.isSameEndpoint({
        registered: 'https://flow.example.org/api/v1/webhooks/flow1/test',
        webhookUrl: 'https://flow.example.org/api/v1/webhooks/flow1',
      })
    ).toBe(false);
  });

  it('does not match another flow', () => {
    expect(
      telegramWebhookAuth.isSameEndpoint({
        registered: 'https://flow.example.org/api/v1/webhooks/flow2',
        webhookUrl: 'https://flow.example.org/api/v1/webhooks/flow1',
      })
    ).toBe(false);
  });

  // Telegram reports `''` when it holds no webhook, and a malformed value must not throw.
  it.each(['', 'not a url'])('treats %o as no match rather than throwing', (registered) => {
    expect(
      telegramWebhookAuth.isSameEndpoint({
        registered,
        webhookUrl: 'https://flow.example.org/api/v1/webhooks/flow1',
      })
    ).toBe(false);
  });
});

describe('setWebhook failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not put the secret into the error a user will read', async () => {
    const secret = telegramWebhookAuth.secretFor({
      botToken: BOT_TOKEN,
      webhookUrl: WEBHOOK_URL,
    });
    sendRequest.mockRejectedValue(
      new Error(JSON.stringify({ request: { body: { url: WEBHOOK_URL, secret_token: secret } } }))
    );

    const failure = await telegramCommons
      .subscribeWebhook(BOT_TOKEN, WEBHOOK_URL, { secret_token: secret })
      .catch((error: Error) => error);

    expect(failure.message).not.toContain(secret);
    // Still diagnosable — the reason the user needs is kept.
    expect(failure.message).toContain(WEBHOOK_URL);
  });
});
