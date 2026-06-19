import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { askGpt } from './lib/actions/ask-gpt';
import { azureOpenaiAuth } from './lib/auth';

export const azureOpenai = createQadam({
  displayName: 'Azure OpenAI',
  description: 'Powerful AI tools from Microsoft',
  auth: azureOpenaiAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/azure-openai.png',
  authors: ["MoShizzle","abuaboud"],
  actions: [askGpt],
  triggers: [],
});
