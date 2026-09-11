import {
  QadamEventPuller,
  QadamEventPullOutcome,
  QadamEventPullResult,
  WaitForEventsParams,
} from '@aiqadam/qadams-framework';

/**
 * Telegram's `getUpdates` window, in seconds. Deliberately not operator-tunable: the host keeps
 * no sandbox slot busy while a window is open, so there is nothing to trade away by shortening it.
 */
const WINDOW_SECONDS = 50;

/** Headroom over the window, so a slow response is not mistaken for a hung request. */
const REQUEST_TIMEOUT_MS = (WINDOW_SECONDS + 10) * 1000;

/**
 * 401/404 mean the token is gone and 400 means the request itself is malformed — neither gets
 * better by being retried. 409 is deliberately absent: Telegram returns it both for "a webhook is
 * still registered" (fatal) and for "another getUpdates call took over" (transient — the trigger's
 * own test() does exactly that), so it is classified on the description instead.
 */
const FATAL_STATUS_CODES = [400, 401, 404];

const WEBHOOK_CONFLICT_STATUS = 409;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isBotTokenAuth = (auth: unknown): auth is { secret_text: string } =>
  isRecord(auth) && typeof auth.secret_text === 'string';

const readTransport = (config: unknown): string | undefined => {
  if (!isRecord(config) || typeof config.transport !== 'string') {
    return undefined;
  }
  return config.transport;
};

const readAllowedUpdates = (config: unknown): string[] => {
  if (!isRecord(config) || !Array.isArray(config.update_types)) {
    return [];
  }
  return config.update_types.filter(
    (updateType: unknown): updateType is string => typeof updateType === 'string'
  );
};

const readDescription = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.description === 'string' ? body.description : undefined;

const readRetryAfterSeconds = (body: unknown): number | undefined => {
  if (!isRecord(body) || !isRecord(body.parameters)) {
    return undefined;
  }
  const retryAfter = body.parameters.retry_after;
  return typeof retryAfter === 'number' ? retryAfter : undefined;
};

const readUpdates = (body: unknown): unknown[] | undefined => {
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.result)) {
    return undefined;
  }
  return body.result;
};

const nextOffset = (params: { updates: unknown[], cursor: string | undefined }): string | undefined => {
  const { updates, cursor } = params;
  const updateIds = updates
    .filter(isRecord)
    .map((update) => update.update_id)
    .filter((updateId: unknown): updateId is number => typeof updateId === 'number');
  if (updateIds.length === 0) {
    return cursor;
  }
  return String(Math.max(...updateIds) + 1);
};

/**
 * A bot token is `<bot_id>:<secret>`, and Telegram accepts one `getUpdates` consumer per bot — so
 * the bot id is both the right unit of consumption and safe to put in a Redis key or a log line.
 * It also survives a token being regenerated, which keeps the cursor valid across a rotation.
 */
const botId = (auth: unknown): string | undefined => {
  if (!isBotTokenAuth(auth)) {
    return undefined;
  }
  const [id] = auth.secret_text.split(':');
  return id.length > 0 ? id : undefined;
};

const buildUrl = (params: {
  botToken: string,
  cursor: string | undefined,
  allowedUpdates: string[],
}): string => {
  const { botToken, cursor, allowedUpdates } = params;
  const query = new URLSearchParams({ timeout: String(WINDOW_SECONDS) });
  if (cursor !== undefined) {
    query.set('offset', cursor);
  }
  if (allowedUpdates.length > 0) {
    query.set('allowed_updates', JSON.stringify(allowedUpdates));
  }
  return `https://api.telegram.org/bot${botToken}/getUpdates?${query.toString()}`;
};

async function waitForEvents({
  auth,
  config,
  cursor,
  signal,
}: WaitForEventsParams): Promise<QadamEventPullResult> {
  if (!isBotTokenAuth(auth)) {
    return {
      outcome: QadamEventPullOutcome.FATAL,
      reason: 'Telegram long polling requires a bot-token connection',
    };
  }

  const url = buildUrl({
    botToken: auth.secret_text,
    cursor,
    allowedUpdates: readAllowedUpdates(config),
  });

  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const description = readDescription(body);
    const retryAfterSeconds = readRetryAfterSeconds(body);
    const suffix = description ? `: ${description}` : '';

    if (!response.ok) {
      const reason = `Telegram getUpdates failed with ${response.status}${suffix}`;
      const webhookStillRegistered =
        response.status === WEBHOOK_CONFLICT_STATUS && (description ?? '').includes('webhook');
      if (FATAL_STATUS_CODES.includes(response.status) || webhookStillRegistered) {
        return { outcome: QadamEventPullOutcome.FATAL, reason };
      }
      return { outcome: QadamEventPullOutcome.RETRYABLE, reason, retryAfterSeconds };
    }

    const updates = readUpdates(body);
    if (updates === undefined) {
      return {
        outcome: QadamEventPullOutcome.RETRYABLE,
        reason: `Telegram getUpdates returned an unexpected body${suffix}`,
        retryAfterSeconds,
      };
    }

    return {
      outcome: QadamEventPullOutcome.EVENTS,
      events: updates,
      nextCursor: nextOffset({ updates, cursor }),
    };
  }
  catch (error) {
    return {
      outcome: QadamEventPullOutcome.RETRYABLE,
      reason: `Telegram getUpdates could not be reached: ${
        error instanceof Error ? error.message : 'unknown transport error'
      }`,
    };
  }
}

export const TelegramTransport = {
  WEBHOOK: 'webhook',
  LONG_POLLING: 'long_polling',
} as const;

export const telegramEventPuller: QadamEventPuller = {
  windowSeconds: WINDOW_SECONDS,
  isEnabledFor: ({ config }) => readTransport(config) === TelegramTransport.LONG_POLLING,
  credentialKey: ({ auth }) => botId(auth),
  waitForEvents,
};
