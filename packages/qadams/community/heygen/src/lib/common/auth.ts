import { HttpMethod } from '@aiqadam/qadams-common';
import { QadamAuth } from '@aiqadam/qadams-framework';
import { heygenApiCall } from './client';

export const heygenAuth = QadamAuth.SecretText({
	displayName: 'API Key',
	description: `You can obtain your API key by navigating to your Space Settings in HeyGen App.`,
	required: true,
	validate: async ({ auth }) => {
		try {
			await heygenApiCall({
				apiKey: auth as string,
				method: HttpMethod.GET,
				resourceUri: '/user/me',
				apiVersion: 'v1',
			});
			return { valid: true };
		} catch {
			return {
				valid: false,
				error: 'Invalid API Key.',
			};
		}
	},
});
