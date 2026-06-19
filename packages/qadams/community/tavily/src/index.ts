import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { searchAction } from './lib/actions/search';
import { extractAction } from './lib/actions/extract';
import { tavilyAuth } from './lib/auth';

export const tavily = createQadam({
	displayName: 'Tavily',
	description: 'Search engine tailored for AI agents.',
	minimumSupportedRelease: '0.30.0',
	logoUrl: '/assets/qadams/tavily.jpg',
	categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
	authors: ['OsamaHaikal'],
	auth: tavilyAuth,
	actions: [searchAction, extractAction,
		createCustomApiCallAction({
			baseUrl: () => 'https://api.tavily.com',
			auth: tavilyAuth,
			authMapping: async (auth) => ({ Authorization: `Bearer ${auth.secret_text}` }),
		})
	],
	triggers: [],
});
