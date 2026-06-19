import {
	OAuth2PropertyValue,
	createQadam,
	PiecePropValueSchema,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { listTicketsAction } from './lib/actions/list-tickets';
import { createTicketAction } from './lib/actions/create-ticket';
import { organizationId } from './lib/common/props';
import { findContactAction } from './lib/actions/find-contact';
import { zohoDeskAuth } from './lib/common/auth';

export const piecesZohoDesk = createQadam({
	displayName: 'Zoho Desk',
	description: 'Helpdesk management software',
	auth: zohoDeskAuth,
	categories: [QadamCategory.CUSTOMER_SUPPORT],
	minimumSupportedRelease: '0.36.1',
	logoUrl: '/assets/qadams/zoho-desk.png',
	authors: ['volubile', 'kishanprmr'],
	actions: [
		listTicketsAction,
		createTicketAction,
		findContactAction,
		createCustomApiCallAction({
			baseUrl: (auth) => {
				const authValue = auth as PiecePropValueSchema<typeof zohoDeskAuth>;
				const location = authValue.props?.['location'] ?? 'zoho.com';
				return `https://desk.${location}/api/v1`;
			},
			auth: zohoDeskAuth,
			authMapping: async (auth) => ({
				Authorization: `Zoho-oauthtoken ${(auth as OAuth2PropertyValue).access_token}`,
			}),
			extraProps: {
				orgId: organizationId({
					displayName: 'Organization ID',
					description: 'Select organization ID to include in auth headers.',
					required: false,
				}),
			},
		}),
	],
	triggers: [],
});
