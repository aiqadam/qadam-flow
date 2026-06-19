import { QadamAuth } from '@aiqadam/qadams-framework';

export const gitlabAuth = QadamAuth.OAuth2({
  required: true,
  authUrl: 'https://gitlab.com/oauth/authorize',
  tokenUrl: 'https://gitlab.com/oauth/token',
  scope: ['api', 'read_user'],
});
