import { QadamAuth } from '@aiqadam/qadams-framework';

export const lokaliseAuth = QadamAuth.SecretText({
  displayName: 'API Token',
  description:
    'Lokalise API Token. You can generate one from your Lokalise account.',
  required: true,
});
