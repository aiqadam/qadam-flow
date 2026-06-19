import { createQadam } from '@aiqadam/qadams-framework';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { askClaude } from './lib/actions/send-prompt';
import { baseUrl } from './lib/common/common';
import { QadamCategory } from '@aiqadam/shared';
import { extractStructuredDataAction } from './lib/actions/extract-structured-data';
import { claudeAuth } from './lib/auth';

export const claude = createQadam({
  displayName: 'Anthropic Claude',
  auth: claudeAuth,
  minimumSupportedRelease: '0.63.0',
  logoUrl: '/assets/qadams/claude.png',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  authors: ['dennisrongo','kishanprmr'],
  actions: [
    askClaude,
    extractStructuredDataAction,
    createCustomApiCallAction({
      auth: claudeAuth,
      baseUrl: () => baseUrl,
      authMapping: async (auth) => {
        return {
          'x-api-key': `${auth.secret_text}`,
        };
      },
    }),
  ],
  triggers: [],
});
