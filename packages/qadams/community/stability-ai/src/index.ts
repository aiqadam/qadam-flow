import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  QadamAuth,
  Property,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { textToImage } from './lib/actions/text-to-image';

export const stabilityAiAuth = QadamAuth.CustomAuth({
  description: `Please visit https://platform.stability.ai/docs/getting-started/authentication to get your API Key`,
  props: {
    api_key: Property.ShortText({
      displayName: 'API Key',
      required: true,
    }),
  },
  required: true,
});

export const stabilityAi = createQadam({
  displayName: 'Stability AI',
  description:
    'Generative AI video model based on the image model Stable Diffusion.',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/stability-ai.png',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  authors: ["Willianwg","camilou","kishanprmr","MoShizzle","AbdulTheActivePiecer","khaledmashaly","abuaboud"],
  auth: stabilityAiAuth,
  actions: [
    textToImage,
    createCustomApiCallAction({
      baseUrl: () => 'https://api.stability.ai/v1',
      auth: stabilityAiAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${auth.props.api_key}`,
      }),
    }),
  ],
  triggers: [],
});
