import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  QadamAuth,
  Property,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { getContactFromID } from './lib/actions/get-contact-from-id';
import { getTicketStatus } from './lib/actions/get-ticket-status';
import { getTickets } from './lib/actions/get-tickets';
import { getContacts } from './lib/actions/get-contacts';
import { getAllTicketsByStatus } from './lib/actions/get-all-tickets-by-status';

export const freshdeskAuth = QadamAuth.CustomAuth({
  props: {
    base_url: Property.ShortText({
      displayName: 'Base URL',
      description: 'Enter the base URL',
      required: true,
    }),
    access_token: Property.ShortText({
      displayName: 'API Token',
      description: 'Enter the API token',
      required: true,
    }),
  },
  description: `Get the API token by visiting your profile settings and clicking View API key`,
  required: true,
});

export const freshdesk = createQadam({
  displayName: 'Freshdesk',
  description: 'Customer support software',

  logoUrl: '/assets/qadams/freshdesk.png',
  categories: [QadamCategory.CUSTOMER_SUPPORT],
  authors: ["buttonsbond","kishanprmr","MoShizzle","AbdulTheActivePiecer","abuaboud"],
  auth: freshdeskAuth,
  actions: [
    getTickets,
    getContactFromID,
    getTicketStatus,
    getContacts,
    getAllTicketsByStatus,
    createCustomApiCallAction({
     baseUrl: (auth) => (auth?.props.base_url ?? ''),
      auth: freshdeskAuth,
      authMapping: async (auth) => ({
        Authorization: (auth.props.access_token),
      }),
    }),
  ],
  triggers: [],
});
