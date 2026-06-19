import { createQadam } from '@aiqadam/qadams-framework';
import { deepgramAuth } from './common/auth';
import { createSummaryAction } from './actions/create-summary';
import { createTranscriptionCallbackAction } from './actions/create-transcription';
import { listProjectsAction } from './actions/list-projects';
import { textToSpeechAction } from './actions/text-to-speech';
import { QadamCategory } from '@aiqadam/shared';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { BASE_URL } from './common/constants';

export const deepgramPiece = createQadam({
  displayName: 'Deepgram',
  logoUrl: '/assets/qadams/deepgram.png',
  description:
    'Deepgram is an AI-powered speech recognition platform that provides real-time transcription, text-to-speech, and audio analysis capabilities.',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  minimumSupportedRelease: '0.30.0',
  authors: ['Ani-4x', 'kishanprmr'],
  auth: deepgramAuth,
  actions: [
    createSummaryAction,
    createTranscriptionCallbackAction,
    listProjectsAction,
    textToSpeechAction,
    createCustomApiCallAction({
      auth: deepgramAuth,
      baseUrl: () => BASE_URL,
      authMapping: async (auth) => {
        return {
          Authorization: `Token ${auth.secret_text}`,
        };
      },
    }),
  ],
  triggers: [],
});
