import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, httpClient: { sendRequest } };
});

const { telegramNewMessage } = await import('../src/lib/trigger/new-message');
const { telegramWebhookAuth } = await import('../src/lib/webhook-auth');

const BOT_TOKEN = '7777777:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WEBHOOK_URL = 'https://flow.example.org/api/v1/webhooks/flow1';
const UPDATE = { update_id: 1, message: { text: 'hello' } };

const secret = telegramWebhookAuth.secretFor({
  botToken: BOT_TOKEN,
  webhookUrl: WEBHOOK_URL,
});

function contextWith({ transport, headers }: ContextWithParams) {
  const store = new Map<string, unknown>();
  if (transport !== undefined) {
    store.set(telegramWebhookAuth.TRANSPORT_KEY, transport);
  }
  return {
    auth: { secret_text: BOT_TOKEN },
    webhookUrl: WEBHOOK_URL,
    propsValue: { update_types: [] },
    payload: { body: UPDATE, headers: headers ?? {}, queryParams: {} },
    store: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
        return value;
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * `run` is the only place a forged update can be stopped: the webhook endpoint is public by design
 * and knows nothing about Telegram. An accepted forgery makes the bot act on attacker-chosen
 * content — a `chat.id` it picks, a `from.id` that defeats any "who may command me" branch.
 */
describe('telegram trigger run verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A registered webhook unless a case says otherwise, so the legacy path takes its pushed branch.
    sendRequest.mockResolvedValue({ body: { ok: true, result: { url: WEBHOOK_URL } } });
  });

  it('accepts an update carrying the secret Telegram was given', async () => {
    const result = await telegramNewMessage.run(
      contextWith({
        transport: telegramWebhookAuth.WEBHOOK,
        headers: { [telegramWebhookAuth.HEADER]: secret },
      })
    );

    expect(result).toEqual([UPDATE]);
  });

  it('drops a forged update that carries no secret', async () => {
    const result = await telegramNewMessage.run(
      contextWith({ transport: telegramWebhookAuth.WEBHOOK, headers: {} })
    );

    expect(result).toEqual([]);
  });

  it('drops a forged update that guesses wrong', async () => {
    const result = await telegramNewMessage.run(
      contextWith({
        transport: telegramWebhookAuth.WEBHOOK,
        headers: { [telegramWebhookAuth.HEADER]: 'guessed' },
      })
    );

    expect(result).toEqual([]);
  });

  // Dropping rather than throwing: a forger must not be able to fill the run history, and an error
  // page tells them their forgery reached something.
  it('does not throw on a forgery', async () => {
    await expect(
      telegramNewMessage.run(
        contextWith({ transport: telegramWebhookAuth.WEBHOOK, headers: {} })
      )
    ).resolves.toEqual([]);
  });

  // In pull mode the update came from this instance's own polling host, which talks to Telegram
  // directly and has no header to echo. Demanding one here would drop every update.
  //
  // The side effect is the load-bearing half: `setWebhook` and `getUpdates` are mutually exclusive
  // per token, so registering a webhook here would stop the very polling that delivered this
  // update. Asserting only the return value cannot see that — the accept-and-upgrade branch
  // returns the same thing while breaking the transport.
  it('accepts a polled update without re-registering the webhook that would stop the polling', async () => {
    const result = await telegramNewMessage.run(
      contextWith({ transport: telegramWebhookAuth.LONG_POLLING, headers: {} })
    );

    expect(result).toEqual([UPDATE]);
    expect(
      sendRequest.mock.calls.filter(([request]) =>
        String(request.url).includes('/setWebhook')
      )
    ).toEqual([]);
  });

  // A webhook registered before this fix carries no secret, so Telegram sends no header. Refusing
  // would silently drop real messages until someone happened to republish — the exact silent-bot
  // failure this area exists to prevent. One update is accepted, and the secret is registered
  // during it, so the window is a single update rather than a deploy.
  it('accepts one update from a pre-fix registration, and registers the secret during it', async () => {
    const context = contextWith({ transport: undefined, headers: {} });

    const result = await telegramNewMessage.run(context);

    expect(result).toEqual([UPDATE]);
    const setWebhook = sendRequest.mock.calls.find(([request]) =>
      String(request.url).includes('/setWebhook')
    );
    expect(setWebhook?.[0].body.secret_token).toBe(secret);
    expect(await context.store.get(telegramWebhookAuth.TRANSPORT_KEY)).toBe(
      telegramWebhookAuth.WEBHOOK
    );
  });

  // A flow already on the pull transport, enabled before this fix, has no mode recorded either —
  // and it looks exactly like a pre-fix webhook registration from inside `run`. Registering a
  // webhook for it would stop the very polling that delivered the update, so the two are told apart
  // by asking Telegram whether a webhook exists at all.
  it('does not re-register a webhook for a pre-fix flow that is being polled', async () => {
    sendRequest.mockResolvedValue({ body: { ok: true, result: { url: '' } } });
    const context = contextWith({ transport: undefined, headers: {} });

    const result = await telegramNewMessage.run(context);

    expect(result).toEqual([UPDATE]);
    expect(
      sendRequest.mock.calls.filter(([request]) =>
        String(request.url).includes('/setWebhook')
      )
    ).toEqual([]);
    // And it records the mode, so the question is asked once rather than on every update.
    expect(await context.store.get(telegramWebhookAuth.TRANSPORT_KEY)).toBe(
      telegramWebhookAuth.LONG_POLLING
    );
  });

  it('then demands the header from the very next update', async () => {
    const context = contextWith({ transport: undefined, headers: {} });
    await telegramNewMessage.run(context);

    const next = { ...context, payload: { ...context.payload, headers: {} } };
    expect(await telegramNewMessage.run(next)).toEqual([]);
  });
});

type ContextWithParams = {
  transport: string | undefined;
  headers?: Record<string, string>;
};
