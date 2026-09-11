import { createTrigger, Property, TriggerStrategy } from '@aiqadam/qadams-framework';
import { telegramCommons } from '../common';
import { telegramTransport } from '../long-polling';
import { telegramWebhookAuth } from '../webhook-auth';
import { telegramBotAuth } from '../auth';
import { httpClient, HttpMethod, HttpRequest } from '@aiqadam/qadams-common';

type TelegramUpdate = Record<string, unknown> & { update_id?: number };

type GetUpdatesResponse = {
  ok: boolean;
  result: TelegramUpdate[];
};

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
    // header to echo. Nothing arrives here from Telegram in this mode — the qadam called
    // deleteWebhook — and core already refuses pushed deliveries for a pulling flow.
    if (transport === telegramWebhookAuth.LONG_POLLING) {
      return [context.payload.body];
    }

    // No mode recorded: this flow was enabled by a version that predates the secret, so Telegram is
    // either pushing to a webhook registered without one, or not pushing at all because the flow is
    // being polled. Those are indistinguishable from here — `run` deliberately does not read the
    // connection's metadata, which is the hot path for every inbound event product-wide — so ask
    // Telegram. Registering a webhook for a polled flow would stop the polling that delivered this.
    if (transport !== telegramWebhookAuth.WEBHOOK) {
      const pushed = await telegramCommons.hasRegisteredWebhook(context.auth.secret_text);
      if (!pushed) {
        await context.store.put(
          telegramWebhookAuth.TRANSPORT_KEY,
          telegramWebhookAuth.LONG_POLLING
        );
        return [context.payload.body];
      }
      // Accepting this one update is deliberate: refusing would silently drop real messages until
      // someone happened to republish, which is the failure this area exists to prevent. The secret
      // is registered during it, so the window is one update rather than a deploy.
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
  async test(context) {
    const messages = await getLastFiveMessages(context.auth.secret_text);
    return messages.result;
  },
});

const getLastFiveMessages = async (botToken: string) => {
  const request: HttpRequest = {
    method: HttpMethod.GET,
    url: `https://api.telegram.org/bot${botToken}/getUpdates?offset=-5`,
  };
  const response = await httpClient.sendRequest<GetUpdatesResponse>(request);
  return response.body;
};

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

