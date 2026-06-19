import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { catchWebhook } from './lib/triggers/catch-hook';
import { QadamCategory } from '@aiqadam/shared';
import { returnResponse } from './lib/actions/return-response';
import { returnResponseAndWaitForNextWebhook } from './lib/actions/return-response-and-wait-for-next-webhook';

export const webhook = createQadam({
  displayName: 'Webhook',
  description: 'Receive HTTP requests and trigger flows using unique URLs.',
  auth: QadamAuth.None(),
  categories: [QadamCategory.CORE],
  minimumSupportedRelease: '0.82.0',
  logoUrl: '/assets/qadams/new-core/webhooks.svg',
  authors: ['abuaboud', 'pfernandez98', 'kishanprmr','AbdulTheActivePiecer'],
  actions: [returnResponse,returnResponseAndWaitForNextWebhook],
  triggers: [catchWebhook],
});
