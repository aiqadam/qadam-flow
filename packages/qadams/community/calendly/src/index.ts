import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { calendlyCommon } from './lib/common';
import { calendlyInviteeCanceled } from './lib/trigger/invitee-canceled.trigger';
import { calendlyInviteeCreated } from './lib/trigger/invitee-created.trigger';
import { calendlyAuth } from './lib/auth';

const markdown = `
## Obtain your Calendly Personal Token
1. Go to https://calendly.com/integrations/api_webhooks
2. Click on "Create New Token"
3. Copy the token and paste it in the field below
`;
export const calendly = createQadam({
  displayName: 'Calendly',
  description: 'Simple, modern scheduling',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/calendly.png',
  categories: [QadamCategory.PRODUCTIVITY],
  authors: ["kishanprmr","MoShizzle","AbdulTheActivePiecer","khaledmashaly","abuaboud"],
  auth: calendlyAuth,
  actions: [
    createCustomApiCallAction({
      baseUrl: () => calendlyCommon.baseUrl, // Replace with the actual base URL
      auth: calendlyAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${auth.secret_text}`,
      }),
    }),
  ],
  triggers: [calendlyInviteeCreated, calendlyInviteeCanceled],
});
