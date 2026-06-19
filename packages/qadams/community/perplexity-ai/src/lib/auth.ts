import { QadamAuth } from '@aiqadam/qadams-framework';

export const perplexityAiAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  required: true,
  description: `
  Navigate to [API Settings](https://www.perplexity.ai/settings/api) and create new API key.
  `,
});
