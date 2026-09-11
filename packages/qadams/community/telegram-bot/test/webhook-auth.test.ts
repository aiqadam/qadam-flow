import { describe, expect, it } from 'vitest';
import { telegramWebhookAuth } from '../src/lib/webhook-auth';

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

  // It is keyed by the token, so it must not be derivable from public material alone.
  it('does not contain the bot token', () => {
    expect(secret).not.toContain(BOT_TOKEN);
    expect(secret).not.toContain(BOT_TOKEN.split(':')[1]);
  });
});
