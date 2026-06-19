import { QadamAuth } from '@aiqadam/qadams-framework';

export const ticktickAuth = QadamAuth.OAuth2({
	authUrl: 'https://ticktick.com/oauth/authorize',
	tokenUrl: 'https://ticktick.com/oauth/token',
	required: true,
	scope: ['tasks:read', 'tasks:write'],
});
