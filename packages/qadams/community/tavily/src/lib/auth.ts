import { QadamAuth } from '@aiqadam/qadams-framework';
import { AuthenticationType, httpClient, HttpMethod } from '@aiqadam/qadams-common';

const markdownDescription = `
Follow these steps to obtain your Tavily API Key:

1. Visit [tavily](https://tavily.com/) and create an account.
2. Log in and navigate to your dashboard.
3. Locate and copy your API key from the dashboard.
`;

export const tavilyAuth = QadamAuth.SecretText({
	description: markdownDescription,
	displayName: 'API Key',
	required: true,
	validate: async ({ auth }) => {
		try {
			await httpClient.sendRequest({
				method: HttpMethod.GET,
				url: 'https://api.tavily.com/usage',
				authentication: {
					type: AuthenticationType.BEARER_TOKEN,
					token: auth
				}
			});
			return {
				valid: true,
			};
		} catch (e) {
			return {
				valid: false,
				error: 'Invalid API Key',
			};
		}
	},
});
