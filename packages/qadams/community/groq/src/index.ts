import {
  AuthenticationType,
  HttpMethod,
  createCustomApiCallAction,
  httpClient,
} from '@aiqadam/qadams-common';
import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { askGroq } from './lib/actions/ask-groq';
import { transcribeAudio } from './lib/actions/transcribe-audio';
import { translateAudio } from './lib/actions/translate-audio';

const baseUrl = 'https://api.groq.com/openai/v1';

export const groqAuth = QadamAuth.SecretText({
  description: 'Enter your Groq API Key',
  displayName: 'API Key',
  required: true,
  validate: async (auth) => {
    try {
      await httpClient.sendRequest<{
        data: { id: string }[];
      }>({
        url: `${baseUrl}/models`,
        method: HttpMethod.GET,
        authentication: {
          type: AuthenticationType.BEARER_TOKEN,
          token: auth.auth,
        },
      });
      return {
        valid: true,
      };
    } catch (e) {
      return {
        valid: false,
        error: 'Invalid API key',
      };
    }
  },
});

export const groq = createQadam({
  displayName: 'Groq',
  description: 'Use Groq\'s fast language models and audio processing capabilities.',
  minimumSupportedRelease: '0.9.0',
  logoUrl: '/assets/qadams/groq.png',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  auth: groqAuth,
  actions: [
    askGroq,
    transcribeAudio,
    translateAudio,
    createCustomApiCallAction({
      auth: groqAuth,
      baseUrl: () => baseUrl,
      authMapping: async (auth) => {
        return {
          Authorization: `Bearer ${auth.secret_text}`,
        };
      },
    }),
  ],
  authors: ['abuaboud'],
  triggers: [],
});
