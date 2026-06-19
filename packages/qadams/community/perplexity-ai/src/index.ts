import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createChatCompletionAction } from './lib/actions/create-chat-completion.action';
import { perplexityAiAuth } from './lib/auth';

export const perplexityAi = createQadam({
  displayName: 'Perplexity AI',
  auth: perplexityAiAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/perplexity-ai.png',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  description: 'AI powered search engine',
  authors: ['kishanprmr','AbdulTheActivePiecer'],
  actions: [createChatCompletionAction],
  triggers: [],
});
