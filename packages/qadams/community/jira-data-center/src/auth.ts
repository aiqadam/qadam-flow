import {
	AppConnectionValueForAuthProperty,
	QadamAuth,
	Property,
} from '@aiqadam/qadams-framework';
import { sendJiraRequest } from './lib/common';
import { HttpError, HttpMethod } from '@aiqadam/qadams-common';
import { z } from 'zod';
import { propsValidation } from '@aiqadam/qadams-common';
import { AppConnectionType } from '@aiqadam/shared';

export const jiraDataCenterAuth = QadamAuth.CustomAuth({
	description: `
To generate a Personal Access Token (PAT):
1. Log in to your Jira Data Center instance.
2. Click your **profile icon** (top-right) → **Profile**.
3. Go to **Personal Access Tokens** → **Create token**.
4. Set a name and expiry, then copy the generated token.
    `,
	required: true,
	props: {
		instanceUrl: Property.ShortText({
			displayName: 'Instance URL',
			description:
				'The URL of your Jira Data Center instance (e.g. https://jira.yourcompany.com)',
			required: true,
		}),
		personalAccessToken: QadamAuth.SecretText({
			displayName: 'Personal Access Token',
			description: 'Your Jira Data Center Personal Access Token (PAT)',
			required: true,
		}),
	},
	validate: async ({ auth }) => {
		try {
			await propsValidation.validateZod(auth, {
				instanceUrl: z.string().url(),
			});

			await sendJiraRequest({
				auth: {
					type: AppConnectionType.CUSTOM_AUTH,
					props: auth,
				},
				method: HttpMethod.GET,
				url: 'myself',
			});
			return {
				valid: true,
			};
		} catch (e) {
			const message = ((e as HttpError).response?.body as any)?.message;
			return {
				valid: false,
				error: message ?? 'Invalid credentials',
			};
		}
	},
});

export type JiraDataCenterAuth = AppConnectionValueForAuthProperty<typeof jiraDataCenterAuth>;
