import { createQadam } from '@aiqadam/qadams-framework';
import { generateText } from './lib/actions/generate-text';
import { cohereAuth } from './lib/auth';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';

export const cohere = createQadam({
  displayName: 'Cohere',
  description: 'Generate text using Cohere AI language models',
  auth: cohereAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl:
    '/assets/qadams/cohere.png',
  authors: ['AhmadTash'],
  actions: [generateText,
    createCustomApiCallAction({
      auth: cohereAuth,
      baseUrl: () => 'https://api.cohere.com/v2',
      authMapping: async (auth) => {
        return {
          Authorization: `Bearer ${auth!.secret_text}`,
        };
      },
    })
  ],
  triggers: [],
});
