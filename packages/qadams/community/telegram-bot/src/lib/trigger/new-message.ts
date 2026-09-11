import { createTrigger, Property, TriggerStrategy } from '@aiqadam/qadams-framework';
import { telegramCommons } from '../common';
import { telegramTransport } from '../long-polling';
import { telegramWebhookAuth } from '../webhook-auth';
import { telegramBotAuth } from '../auth';

const UPDATE_TYPE_OPTIONS = [
  { label: 'Message', value: 'message' },
  { label: 'Edited Message', value: 'edited_message' },
  { label: 'Channel Post', value: 'channel_post' },
  { label: 'Edited Channel Post', value: 'edited_channel_post' },
  { label: 'Callback Query (inline button tap)', value: 'callback_query' },
  { label: 'Inline Query', value: 'inline_query' },
  { label: 'Chosen Inline Result', value: 'chosen_inline_result' },
  { label: 'Poll', value: 'poll' },
  { label: 'Poll Answer', value: 'poll_answer' },
  { label: 'My Chat Member', value: 'my_chat_member' },
  { label: 'Chat Member', value: 'chat_member' },
  { label: 'Chat Join Request', value: 'chat_join_request' },
];

const updateTypesDescription = `
Telegram allows only **one webhook per bot token**, so a single Telegram trigger handles all update types for a given bot. Pick the update types this flow should listen for. Leave empty to use Telegram's default set (messages, edited channel posts, chat-member updates — **does not include callback queries**).

After selecting multiple types, use a Branch step downstream to fork on the update kind (e.g. \`message\` vs \`callback_query\`).
`;

/**
 * Deliberately no `test()`. `createTrigger` derives the test strategy from whether one exists, and
 * a `test()` here could only be `getUpdates` — which Telegram refuses in both transports for the
 * same reason: it allows one consumer per bot token. With a webhook registered it answers
 * `409 … can't use getUpdates method while webhook is active`, and while the long-polling host is
 * consuming it answers `409 … terminated by other getUpdates request` and takes the host's window
 * down with it. So pressing Test on a published Telegram flow has never worked.
 *
 * Without one the strategy is simulation: the trigger is enabled against the draft URL and real
 * updates arrive, which is both representative and correct in either transport — the host serves
 * simulation sources too.
 */
export const telegramNewMessage = createTrigger({
  auth: telegramBotAuth,
  name: 'new_telegram_message',
  displayName: 'New Update',
  description:
    'Triggers when the bot receives a Telegram update (message, callback query, poll answer, etc.). One trigger per bot token — Telegram does not support multiple webhooks on the same bot.',
  aiMetadata: { description: 'Fires when the bot receives any selected Telegram update, including new or edited messages, channel posts, inline-button callback queries, poll answers, and chat-member changes. Represents a single inbound update event; since Telegram allows only one webhook per bot token, this one trigger covers all chosen update types for that bot.' },
  props: {
    update_types: Property.StaticMultiSelectDropdown({
      displayName: 'Update Types',
      description: updateTypesDescription,
      required: false,
      options: { options: UPDATE_TYPE_OPTIONS },
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  sampleData: {
    body: {
      message: {
        chat: {
          id: 55169542059,
          type: 'private',
          username: 'AbdallahAlwarawreh',
          last_name: 'Alwarawreh',
          first_name: 'Abdallah',
        },
        date: 1686050152,
        from: {
          id: 55169542059,
          is_bot: false,
          username: 'AbdallahAlwarawreh',
          last_name: 'Alwarawreh',
          first_name: 'Abdallah',
          language_code: 'en',
        },
        parse_mode: 'MarkdownV2',
        text: 'Hello world',
        message_id: 21,
      },
      update_id: 351114420,
    },
  },
  async onEnable(context) {
    // The mode lives on the connection, not here: Telegram allows one consumer per bot token, so
    // two flows sharing a connection must not be able to disagree about how it is consumed.
    if (telegramTransport.isLongPolling(context.authMetadata)) {
      // setWebhook and getUpdates are mutually exclusive per token, so the webhook has to go
      // before the host can poll. Pending updates are kept and delivered by the first poll.
      await telegramCommons.unsubscribeWebhook(context.auth.secret_text);
      await context.store.put(
        telegramWebhookAuth.TRANSPORT_KEY,
        telegramWebhookAuth.LONG_POLLING
      );
      return;
    }
    await registerWebhook(context);
  },
  async onDisable(context) {
    await telegramCommons.unsubscribeWebhook(context.auth.secret_text);
    await context.store.delete(telegramWebhookAuth.TRANSPORT_KEY);
  },
  async run(context) {
    const transport = await context.store.get<string>(
      telegramWebhookAuth.TRANSPORT_KEY
    );

    // Delivered by this instance's own polling host, which talks to Telegram directly and has no
    // header to echo. Telegram pushes nothing in this mode — the qadam called deleteWebhook — and
    // core refuses pushed deliveries for a pulling flow, though only on an instance whose host is
    // running and has synced: that guard is an in-memory set rebuilt once a minute, so it is a
    // second line rather than the reason this branch is safe.
    if (transport === telegramWebhookAuth.LONG_POLLING) {
      return [context.payload.body];
    }

    // No mode recorded: this flow was enabled by a version that predates the secret, so Telegram is
    // either pushing to a webhook registered without one, or not pushing at all because the flow is
    // being polled. Those are indistinguishable from here — `run` deliberately does not read the
    // connection's metadata, which is the hot path for every inbound event product-wide — so ask
    // Telegram which URL it actually delivers to.
    //
    // The comparison is against *this* context's URL, not merely "a webhook exists". The draft and
    // test routes are public and unauthenticated by design, so anyone holding a flow id can reach
    // this code with `webhookUrl` pointing at the draft — and registering that would hand Telegram
    // a URL that never executes the published flow, taking it off the air silently. An equal URL is
    // the only case where re-registering is both safe and useful.
    if (transport !== telegramWebhookAuth.WEBHOOK) {
      const registered = await telegramCommons.registeredWebhookUrl(context.auth.secret_text);
      if (registered !== context.webhookUrl) {
        // Either nothing is registered (the flow is polled, and registering would stop the polling
        // that delivered this update) or Telegram delivers somewhere else entirely. Record the
        // former so the question is asked once; leave the latter alone.
        if (registered === '') {
          await context.store.put(
            telegramWebhookAuth.TRANSPORT_KEY,
            telegramWebhookAuth.LONG_POLLING
          );
        }
        return [context.payload.body];
      }
      // Accepting this update is deliberate: refusing would silently drop real messages until
      // someone happened to republish, which is the failure this area exists to prevent. Concurrent
      // updates can each pass this branch before any of them writes the marker, so the window is
      // bounded by concurrency rather than by exactly one update.
      await registerWebhook(context);
      return [context.payload.body];
    }

    const expected = telegramWebhookAuth.secretFor({
      botToken: context.auth.secret_text,
      webhookUrl: context.webhookUrl,
    });
    if (
      !telegramWebhookAuth.isAuthentic({ headers: context.payload.headers, expected })
    ) {
      // Dropped rather than thrown: a forged update must not be able to fill the run history, and
      // Telegram has nothing to learn from the response either way.
      return [];
    }
    return [context.payload.body];
  },
});

/**
 * Registers the webhook with a `secret_token` and records that this flow is on the pushed
 * transport, so `run` knows to demand the header from then on.
 */
const registerWebhook = async (context: {
  auth: { secret_text: string };
  webhookUrl: string;
  propsValue: { update_types?: unknown };
  store: { put: (key: string, value: unknown) => Promise<unknown> };
}) => {
  await telegramCommons.subscribeWebhook(context.auth.secret_text, context.webhookUrl, {
    allowed_updates: (context.propsValue.update_types ?? []) as string[],
    secret_token: telegramWebhookAuth.secretFor({
      botToken: context.auth.secret_text,
      webhookUrl: context.webhookUrl,
    }),
  });
  await context.store.put(
    telegramWebhookAuth.TRANSPORT_KEY,
    telegramWebhookAuth.WEBHOOK
  );
};

