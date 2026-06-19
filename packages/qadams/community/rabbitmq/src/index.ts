import { createQadam } from '@aiqadam/qadams-framework';
import { messageReceived } from './lib/triggers/message-received';
import { sendMessageToExchange } from './lib/actions/send-message-to-exchange';
import { sendMessageToQueue } from './lib/actions/send-message-to-queue';
import { rabbitmqAuth } from './lib/auth';

export const rabbitmq = createQadam({
  displayName: "RabbitMQ",
  auth: rabbitmqAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: "/assets/qadams/rabbitmq.png",
  authors: [
    "alinperghel"
  ],
  actions: [
    sendMessageToExchange,
    sendMessageToQueue,
  ],
  triggers: [
    messageReceived,
  ],
});
