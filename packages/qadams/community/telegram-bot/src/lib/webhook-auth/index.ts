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

/**
 * The engine appends this to the webhook URL for a simulation — a builder "Test trigger" run. There
 * is no flag on the context saying so, and the difference matters: a simulation borrows the bot's
 * one webhook and has to give it back.
 */
const SIMULATION_SUFFIX = '/test';

/**
 * What Telegram was delivering to before a simulation borrowed the bot's one webhook, recorded by
 * the simulation's own enable hook so its disable hook can put it back exactly.
 *
 * Recorded rather than inferred. The obvious alternative — "restore unless the connection is on the
 * pull transport" — reads the connection's metadata, which is a best-effort fetch on this hook and
 * yields `undefined` on a transient failure. That reads as "not polling", so a hiccup would put a
 * webhook on a bot the polling host is actively consuming: Telegram then refuses `getUpdates`, core
 * refuses the pushed deliveries too, and the flow receives nothing from either transport. An
 * inference that fails open is the wrong shape for undoing something.
 *
 * It also covers the case inference cannot reach at all: a flow that was never published had no
 * webhook before the test, so the right restore is to remove it rather than to register a URL that
 * answers 404 forever and that nothing will ever clean up.
 */
const BORROWED_FROM_KEY = 'qf:telegram:webhook-borrowed-from';

function isSimulation({ webhookUrl }: { webhookUrl: string }): boolean {
  return webhookUrl.endsWith(SIMULATION_SUFFIX);
}

/**
 * Whether Telegram's registered URL is this endpoint. Compared by **path**, not in full: an operator
 * who changes the instance's public URL would otherwise leave every pre-existing flow unable to ever
 * match, stuck unauthenticated and paying a `getWebhookInfo` on every single update. The path still
 * separates production from `/test` and `/draft`, which is the distinction that must not blur.
 */
function isSameEndpoint({ registered, webhookUrl }: { registered: string; webhookUrl: string }): boolean {
  const pathOf = (value: string): string | undefined => {
    try {
      return new URL(value).pathname.replace(/\/+$/, '');
    }
    catch {
      return undefined;
    }
  };
  const registeredPath = pathOf(registered);
  return registeredPath !== undefined && registeredPath === pathOf(webhookUrl);
}

function secretFor({ botToken, webhookUrl }: SecretForParams): string {
  // base64url, so the alphabet is already the A-Za-z0-9_- that Telegram accepts for `secret_token`.
  return createHmac('sha256', botToken)
    .update(webhookUrl)
    .digest('base64url')
    .slice(0, SECRET_LENGTH);
}

/**
 * Constant-time, so a forger cannot learn the secret one character at a time from how long the
 * comparison takes. The length is checked first and returns early — `timingSafeEqual` throws on a
 * mismatch rather than answering — which reveals only that the expected secret is the constant 43
 * characters every derivation produces, and nothing about its contents.
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
  isSimulation,
  isSameEndpoint,
  BORROWED_FROM_KEY,
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
