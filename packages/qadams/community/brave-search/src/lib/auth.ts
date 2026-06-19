import { QadamAuth } from '@aiqadam/qadams-framework';

export const braveSearchAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  required: true,
  description:
    'Your Brave Search API Key (get it from https://brave.com/search/api/)',
});
