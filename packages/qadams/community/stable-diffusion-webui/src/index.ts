import { createQadam } from '@aiqadam/qadams-framework';
import { textToImage } from './lib/actions/text-to-image';
import { stableDiffusionAuth } from './lib/auth';

export type StableDiffusionAuthType = {
  baseUrl: string;
};

export const stableDiffusion = createQadam({
  displayName: 'Stable Dffusion web UI',
  description: 'A web interface for Stable Diffusion',
  auth: stableDiffusionAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/stable-diffusion-webui.png',
  authors: ['AdamSelene', 'abuaboud'],
  actions: [textToImage],
  triggers: [],
});
