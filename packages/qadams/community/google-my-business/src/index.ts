import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  OAuth2PropertyValue,
  QadamAuth,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createReply } from './lib/actions/create-reply';
import { newReview } from './lib/triggers/new-review';

export const googleAuth = QadamAuth.OAuth2({
  authUrl: 'https://accounts.google.com/o/oauth2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  required: true,
  scope: ['https://www.googleapis.com/auth/business.manage'],
});

export const googleBusiness = createQadam({
  auth: googleAuth,
  displayName: 'Google My Business',
  description: 'Manage your business on Google',

  logoUrl: '/assets/qadams/google-business.png',
  authors: ["kishanprmr","MoShizzle","abuaboud"],
  categories: [QadamCategory.MARKETING],
  actions: [
    createReply,
    createCustomApiCallAction({
      baseUrl: () => {
        return 'https://www.googleapis.com/business/v4';
      },
      auth: googleAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  triggers: [newReview],
});
