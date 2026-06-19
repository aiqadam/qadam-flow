import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';

import { cancelSubscription } from './lib/actions/cancel-subscription';
import { createCustomer } from './lib/actions/create-customer';
import { createSubscription } from './lib/actions/create-subscription';
import { getCustomer } from './lib/actions/get-customer';
import { chargebeeAuth } from './lib/auth';
import {
  getChargebeeAuthHeader,
  getChargebeeBaseUrl,
} from './lib/common/client';
import { customerCreated } from './lib/triggers/customer-created';
import { invoiceGenerated } from './lib/triggers/invoice-generated';
import { paymentFailed } from './lib/triggers/payment-failed';
import { paymentSucceeded } from './lib/triggers/payment-succeeded';
import { subscriptionCancelled } from './lib/triggers/subscription-cancelled';
import { subscriptionChanged } from './lib/triggers/subscription-changed';
import { subscriptionCreated } from './lib/triggers/subscription-created';
import { subscriptionRenewed } from './lib/triggers/subscription-renewed';

export const chargebee = createQadam({
  displayName: 'Chargebee',
  description:
    'Subscription billing and revenue operations platform for managing customers and subscriptions.',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/chargebee.png',
  authors: ['Harmatta', 'sanket-a11y'],
  categories: [QadamCategory.ACCOUNTING, QadamCategory.PAYMENT_PROCESSING],
  auth: chargebeeAuth,
  actions: [
    createSubscription,
    cancelSubscription,
    createCustomer,
    getCustomer,
    createCustomApiCallAction({
      auth: chargebeeAuth,
      baseUrl: (auth) => getChargebeeBaseUrl(auth?.props.site ?? ''),
      authMapping: async (auth) => ({
        Authorization: getChargebeeAuthHeader(auth?.props?.api_key ?? ''),
      }),
    }),
  ],
  triggers: [
    subscriptionCreated,
    subscriptionCancelled,
    subscriptionRenewed,
    subscriptionChanged,
    paymentSucceeded,
    paymentFailed,
    invoiceGenerated,
    customerCreated,
  ],
});
