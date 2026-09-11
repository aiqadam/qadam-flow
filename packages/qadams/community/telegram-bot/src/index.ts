import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { telegramAnswerCallbackQueryAction } from './lib/action/answer-callback-query.action';
import { telegramCreateInviteLinkAction } from './lib/action/create-invite-link';
import { telegramDeleteMessageAction } from './lib/action/delete-message.action';
import { telegramEditMessageTextAction } from './lib/action/edit-message-text.action';
import { telegramForwardMessageAction } from './lib/action/forward-message.action';
import { telegramGetChatAction } from './lib/action/get-chat.action';
import { telegramGetChatMemberAction } from './lib/action/get-chat-member';
import { telegramGetFileAction } from './lib/action/get-file.action';
import { telegramPinMessageAction } from './lib/action/pin-message.action';
import { telegramRequestApprovalMessageAction } from './lib/action/request-approval-message';
import { telegramSendAudioAction } from './lib/action/send-audio.action';
import { telegramSendChatActionAction } from './lib/action/send-chat-action.action';
import { telegramSendDocumentAction } from './lib/action/send-document.action';
import { telegramSendLocationAction } from './lib/action/send-location.action';
import { telegramSendMediaAction } from './lib/action/send-media.action';
import { telegramSendMediaGroupAction } from './lib/action/send-media-group.action';
import { telegramSendMessageAction } from './lib/action/send-text-message.action';
import { telegramSendPollAction } from './lib/action/send-poll.action';
import { telegramUnpinMessageAction } from './lib/action/unpin-message.action';
import { telegramBotAuth } from './lib/auth';
import { telegramCommons } from './lib/common';
import { telegramNewMessage } from './lib/trigger/new-message';

export const telegramBot = createQadam({
  displayName: 'Telegram Bot',
  description: 'Build chatbots for Telegram',
  minimumSupportedRelease: '0.0.0',
  logoUrl: '/assets/qadams/telegram_bot.png',
  categories: [QadamCategory.COMMUNICATION],
  auth: telegramBotAuth,
  actions: [
    telegramSendMessageAction,
    telegramSendMediaAction,
    telegramSendDocumentAction,
    telegramSendAudioAction,
    telegramSendLocationAction,
    telegramSendMediaGroupAction,
    telegramSendPollAction,
    telegramSendChatActionAction,
    telegramEditMessageTextAction,
    telegramDeleteMessageAction,
    telegramForwardMessageAction,
    telegramPinMessageAction,
    telegramUnpinMessageAction,
    telegramGetChatAction,
    telegramGetChatMemberAction,
    telegramGetFileAction,
    telegramCreateInviteLinkAction,
    telegramAnswerCallbackQueryAction,
    telegramRequestApprovalMessageAction,
    createCustomApiCallAction({
      baseUrl: (auth) => auth ? telegramCommons.getApiUrl(auth, '') : '',
      auth: telegramBotAuth,
    }),
  ],
  authors: ["abdullahranginwala","tanoggy","alerdenisov","Abdallah-Alwarawreh","kishanprmr","MoShizzle","khaledmashaly","abuaboud",'sanket-a11y'],
  triggers: [telegramNewMessage],
});

export { telegramBotAuth } from './lib/auth';
export { telegramEventPuller, telegramTransport } from './lib/long-polling';
