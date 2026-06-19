import { QadamAuth } from '@aiqadam/qadams-framework';

export const runwayAuth = QadamAuth.SecretText({
	displayName: 'API Key',
	description: 'Your Runway API key. Get it from your Runway account settings.',
	required: true,
});


