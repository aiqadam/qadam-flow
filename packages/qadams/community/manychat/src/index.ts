import { createQadam } from '@aiqadam/qadams-framework';
import { findUserByCustomFieldAction } from './lib/actions/find-user-by-custom-field';
import { createSubscriberAction } from './lib/actions/create-subscriber';
import { sendContentToUserAction } from './lib/actions/send-content-to-user';
import { setCustomFieldAction } from './lib/actions/set-custom-fields';
import { removeTagFromUserAction } from './lib/actions/remove-tag-from-user';
import { addTagToUserAction } from './lib/actions/add-tag-to-user';
import { findUserByNameAction } from './lib/actions/find-user-by-name';
import { QadamCategory } from '@aiqadam/shared';
import { manychatAuth } from './lib/auth';

export const manychat = createQadam({
	displayName: 'Manychat',
	description: 'Automations for Instagram, WhatsApp, TikTok, and Messenger marketing.',
	categories: [QadamCategory.MARKETING],
	auth: manychatAuth,
	minimumSupportedRelease: '0.36.1',
	logoUrl: '/assets/qadams/manychat.png',
	authors: ['neo773', 'kishanprmr'],
	actions: [
		addTagToUserAction,
		createSubscriberAction,
		findUserByCustomFieldAction,
		findUserByNameAction,
		removeTagFromUserAction,
		sendContentToUserAction,
		setCustomFieldAction,
	],
	triggers: [],
});
