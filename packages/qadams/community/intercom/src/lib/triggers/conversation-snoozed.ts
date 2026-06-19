import { createTrigger, TriggerStrategy } from '@aiqadam/qadams-framework';
import { intercomAuth } from '../auth';
import { intercomClient } from '../common';

export const conversationSnoozed = createTrigger({
	// auth: check https://flow.aiqadam.org/docs/developers/qadam-reference/authentication,
	name: 'conversationSnoozed',
	displayName: 'Conversation snoozed',
	description: 'Triggers when a conversation is snoozed',
	aiMetadata: {
		description: 'Fires when a conversation is snoozed in Intercom, meaning an admin temporarily pauses it until a chosen time. Outputs the snoozed conversation object, including its snoozed_until time.',
	},
	props: {},
	sampleData: undefined,
	auth: intercomAuth,
	type: TriggerStrategy.APP_WEBHOOK,
	async onEnable(context) {
		const client = intercomClient(context.auth);
		const response = await client.admins.identify();

		if (!response.app?.id_code) {
			throw new Error('Could not find admin id code');
		}

		context.app.createListeners({
			events: ['conversation.admin.snoozed'],
			identifierValue: response['app']['id_code'],
		});
	},
	async onDisable(context) {
		// implement webhook deletion logic
	},
	async run(context) {
		return [context.payload.body];
	},
});
