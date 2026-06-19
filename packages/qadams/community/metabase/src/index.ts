import { createQadam, QadamAuth, Property } from '@aiqadam/qadams-framework';
import { getQuestion } from './lib/actions/get-question';
import { getQuestionPngPreview } from './lib/actions/get-png-rendering';
import { getDashboardQuestions } from './lib/actions/get-dashboard';
import { queryMetabaseApi } from './lib/common';
import {
  createCustomApiCallAction,
  HttpMethod,
  is_chromium_installed,
} from '@aiqadam/qadams-common';
import { getGraphQuestion } from './lib/actions/get-graph-question';
import { embedQuestion } from './lib/actions/embed-question';
import { AppConnectionType } from '@aiqadam/shared';

const baseProps = {
  baseUrl: Property.ShortText({
    displayName: 'Metabase API base URL',
    required: true,
  }),
  apiKey: QadamAuth.SecretText({
    displayName: 'API key',
    description:
      'Generate one on your Metabase instance (settings -> authentication -> API keys)',
    required: true,
  }),
};

const authProps = is_chromium_installed()
  ? {
      ...baseProps,
      embeddingKey: Property.ShortText({
        displayName: 'Embedding key',
        description:
          'Needed if you want to generate a graph of a question (settings -> embedding -> static embedding).',
        required: false,
      }),
    }
  : baseProps;

export const metabaseAuth = QadamAuth.CustomAuth({
  description: 'Metabase authentication requires a baseUrl and a password.',
  required: true,
  props: authProps,

  validate: async ({ auth }) => {
    try {
      await queryMetabaseApi(
        {
          endpoint: 'login-history/current',
          method: HttpMethod.GET,
        },
        {
          type: AppConnectionType.CUSTOM_AUTH,
          props: auth,
        }
      );
      return {
        valid: true,
      };
    } catch (e) {
      return {
        valid: false,
        error: 'Invalid API Key or base URL',
      };
    }
  },
});

export const metabase = createQadam({
  displayName: 'Metabase',
  description: 'The simplest way to ask questions and learn from data',

  auth: metabaseAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/metabase.png',
  authors: ['AdamSelene', 'abuaboud', 'valentin-mourtialon', 'Kevinyu-alan'],
  actions: [
    getQuestion,
    getQuestionPngPreview,
    getDashboardQuestions,
    embedQuestion,
    ...(is_chromium_installed() ? [getGraphQuestion] : []),
    createCustomApiCallAction({
      auth: metabaseAuth,
      baseUrl: (auth) =>
        auth ? `${auth.props.baseUrl.replace(/\/$/, '')}/api` : '',
      authMapping: async (auth) => ({
        'X-API-KEY': auth.props.apiKey,
      }),
    }),
  ],
  triggers: [],
});
