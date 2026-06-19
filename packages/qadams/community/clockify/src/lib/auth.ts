import { QadamAuth } from '@aiqadam/qadams-framework';
import { HttpMethod } from '@aiqadam/qadams-common';
import { clockifyApiCall } from './common/client';

export const clockifyAuth = QadamAuth.SecretText({
	displayName:'API Key',
	description: `You can obtain your API key by navigating to **Preferences->Advanced**.`,
	required: true,
	validate: async ({ auth }) => {
		try {
			await clockifyApiCall({
				apiKey: auth,
				method: HttpMethod.GET,
				resourceUri: '/user',
			});

			return {
				valid: true,
			};
		} catch {
			return {
				valid: false,
				error: 'Invalid API Key.',
			};
		}
	},
});
