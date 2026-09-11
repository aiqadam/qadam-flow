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

function contextWith({ transport, headers, webhookUrl, authMetadata, borrowedFrom }: ContextWithParams) {
  const store = new Map<string, unknown>();
  if (transport !== undefined) {
    store.set(telegramWebhookAuth.TRANSPORT_KEY, transport);
  }
  if (borrowedFrom !== undefined) {
    store.set(telegramWebhookAuth.BORROWED_FROM_KEY, borrowedFrom);
  }
  return {
    auth: { secret_text: BOT_TOKEN },
    webhookUrl: webhookUrl ?? WEBHOOK_URL,
    propsValue: { update_types: [] },
    payload: { body: UPDATE, headers: headers ?? {}, queryParams: {} },
    authMetadata,
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

  // The draft and test routes are public and unauthenticated by design, so anyone holding a flow id
  // can reach `run` with `webhookUrl` pointing at the draft. Re-registering that would hand
  // Telegram a URL that never executes the published flow — taking a working flow off the air with
  // one anonymous POST, which is worse than the forgery this whole commit is about.
  it('does not re-point the bot at the draft URL when reached through the draft route', async () => {
    const context = contextWith({
      transport: undefined,
      headers: {},
      webhookUrl: `${WEBHOOK_URL}/test`,
    });

    const result = await telegramNewMessage.run(context);

    expect(result).toEqual([UPDATE]);
    expect(
      sendRequest.mock.calls.filter(([request]) =>
        String(request.url).includes('/setWebhook')
      )
    ).toEqual([]);
    // And it must not be recorded as polled either — Telegram is pushing, just not here.
    expect(await context.store.get(telegramWebhookAuth.TRANSPORT_KEY)).toBeUndefined();
  });

  // Telegram allows one webhook per token, so a simulation borrows the published flow's. The
  // platform disables the simulation on the first update, and deleting the webhook there would
  // leave the bot with none at all — the published trigger source is untouched, so nothing ever
  // runs again to restore it. One press of Test would kill a live flow permanently.
  it('gives the webhook back when a simulation ends, instead of deleting it', async () => {
    await telegramNewMessage.onDisable(
      contextWith({
        transport: telegramWebhookAuth.WEBHOOK,
        webhookUrl: `${WEBHOOK_URL}/test`,
        borrowedFrom: { url: WEBHOOK_URL, allowedUpdates: ['message', 'callback_query'] },
      })
    );

    const calls = sendRequest.mock.calls.map(([request]) => String(request.url));
    expect(calls.some((url) => url.includes('/deleteWebhook'))).toBe(false);
    const setWebhook = sendRequest.mock.calls.find(([request]) =>
      String(request.url).includes('/setWebhook')
    );
    // Exactly what was borrowed: the production URL, its secret, and *its* update types — not the
    // draft's, which would silently narrow what the live webhook receives.
    expect(setWebhook?.[0].body.url).toBe(WEBHOOK_URL);
    expect(setWebhook?.[0].body.secret_token).toBe(secret);
    expect(setWebhook?.[0].body.allowed_updates).toEqual(['message', 'callback_query']);
  });

  // Nothing was registered before the test — a polled connection, or a flow never published. The
  // restore is to remove it. Registering here would put a webhook on a bot the polling host is
  // consuming, or leave an orphan URL answering 404 that nothing ever cleans up.
  it.each<[string, string | undefined]>([
    ['a polled connection', telegramWebhookAuth.LONG_POLLING],
    ['a flow that was never published', undefined],
  ])('removes the webhook after a test on %s', async (_case, transport) => {
    await telegramNewMessage.onDisable(
      contextWith({
        transport,
        webhookUrl: `${WEBHOOK_URL}/test`,
        borrowedFrom: { url: '', allowedUpdates: [] },
      })
    );

    const calls = sendRequest.mock.calls.map(([request]) => String(request.url));
    expect(calls.some((url) => url.includes('/deleteWebhook'))).toBe(true);
    expect(calls.some((url) => url.includes('/setWebhook'))).toBe(false);
  });

  // The record is what makes the restore exact; without it there is nothing to put back, and
  // guessing is what made the previous attempt able to break a polled flow.
  it('records what it is about to overwrite when a simulation starts', async () => {
    sendRequest.mockResolvedValue({ body: { ok: true, result: { url: WEBHOOK_URL, allowed_updates: ['message'] } } });
    const context = contextWith({ transport: undefined, webhookUrl: `${WEBHOOK_URL}/test` });

    await telegramNewMessage.onEnable(context);

    expect(await context.store.get(telegramWebhookAuth.BORROWED_FROM_KEY)).toEqual({
      url: WEBHOOK_URL,
      allowedUpdates: ['message'],
    });
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
