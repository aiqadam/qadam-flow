import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  QadamAuth,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { typeformNewSubmission } from './lib/trigger/new-submission';

export const typeformAuth = QadamAuth.OAuth2({
  required: true,
  tokenUrl: 'https://api.typeform.com/oauth/token',
  authUrl: 'https://admin.typeform.com/oauth/authorize',
  scope: ['webhooks:write', 'forms:read'],
});

export const typeform = createQadam({
  displayName: 'Typeform',
  description: 'Create beautiful online forms and surveys',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/typeform.png',
  categories: [QadamCategory.FORMS_AND_SURVEYS],
  actions: [
    createCustomApiCallAction({
      baseUrl: () => 'https://api.typeform.com',
      auth: typeformAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${auth.access_token}`,
      }),
    }),
  ],
  auth: typeformAuth,
  authors: ["ashrafsamhouri","kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  triggers: [typeformNewSubmission],
});
