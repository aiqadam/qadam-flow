import { QadamAuth } from '@aiqadam/qadams-framework';

export const clickupAuth = QadamAuth.OAuth2({
  description: '',
  authUrl: 'https://app.clickup.com/api',
  tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
  required: true,
  scope: [],
});
