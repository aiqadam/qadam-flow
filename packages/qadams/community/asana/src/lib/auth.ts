import { QadamAuth } from '@aiqadam/qadams-framework';

export const asanaAuth = QadamAuth.OAuth2({
  description: '',
  authUrl: 'https://app.asana.com/-/oauth_authorize',
  tokenUrl: 'https://app.asana.com/-/oauth_token',
  required: true,
  scope: ['default'],
});
