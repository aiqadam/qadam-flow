import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proving that an inbound update really came from Telegram.
 *
 * The webhook endpoint is public by design and the flow id in its URL is the only thing protecting
 * it — and a flow id leaks easily: it is in the builder URL, in exported flow JSON, in screenshots.
 * Without this, anyone holding one can post a forged update, and the flow cannot tell it from a real
 * one: a forged `chat.id` makes the bot send a message to that chat, and a flow that branches on
 * `from.id` to decide who may command it is checking a field the forger chose.
 *
 * Telegram's mechanism for this is `secret_token` on `setWebhook`, echoed back in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every delivery.
 *
 * The secret is **derived, never stored**. It is an HMAC of the webhook URL keyed by the bot token,
 * so both sides can recompute it and nothing new has to be kept anywhere — which matters because
 * the places a qadam could put it are the wrong ones: `connection.metadata` is unencrypted, and the
 * connection value is the credential itself. It is per flow, because the URL is, so one flow's
 * secret says nothing about another's. Rotating the token rotates the secret, and the next
 * `onEnable` re-registers it.
 */
const SECRET_LENGTH = 43;

const HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Which transport this flow's trigger was last enabled with, recorded so `run` knows what to expect
 * of an inbound request. Only the mode is stored — never the secret, which is derived on demand.
 */
const TRANSPORT_KEY = 'qf:telegram:webhook-transport';

function secretFor({ botToken, webhookUrl }: SecretForParams): string {
  // base64url, so the alphabet is already the A-Za-z0-9_- that Telegram accepts for `secret_token`.
  return createHmac('sha256', botToken)
    .update(webhookUrl)
    .digest('base64url')
    .slice(0, SECRET_LENGTH);
}

/**
 * Constant-time, so a forger cannot learn the secret one character at a time from how long the
 * comparison takes. `timingSafeEqual` throws on a length mismatch, which would leak the length, so
 * the lengths are compared first and the result is folded into a comparison that always runs.
 */
function isAuthentic({ headers, expected }: IsAuthenticParams): boolean {
  const provided = headers[HEADER];
  if (typeof provided !== 'string') {
    return false;
  }
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(providedBytes, expectedBytes);
}

export const telegramWebhookAuth = {
  secretFor,
  isAuthentic,
  HEADER,
  TRANSPORT_KEY,
  WEBHOOK: 'webhook',
  LONG_POLLING: 'long_polling',
};

type SecretForParams = {
  botToken: string;
  webhookUrl: string;
};

type IsAuthenticParams = {
  headers: Record<string, string>;
  expected: string;
};
