import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { OAuth2PropertyValue, QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { webflowCreateCollectionItemAction } from './lib/actions/create-collection-item';
import { webflowDeleteCollectionItem } from './lib/actions/delete-collection-item';
import { webflowFindCollectionItem } from './lib/actions/find-collection-item';
import { webflowFindOrder } from './lib/actions/find-order';
import { webflowFulfillOrder } from './lib/actions/fulfill-order';
import { webflowGetCollectionItem } from './lib/actions/get-collection-item';
import { webflowRefundOrder } from './lib/actions/refund-order';
import { webflowUnfulfillOrder } from './lib/actions/unfulfill-order';
import { webflowUpdateCollectionItem } from './lib/actions/update-collection-item';
import { webflowPublishCollectionItem } from './lib/actions/publish-collection-item';
import { webflowListSites } from './lib/actions/list-sites';
import { webflowListCollections } from './lib/actions/list-collections';
import { webflowNewSubmission } from './lib/triggers/new-form-submitted';

export const webflowAuth = QadamAuth.OAuth2({
	description: '',
	authUrl: 'https://webflow.com/oauth/authorize',
	tokenUrl: 'https://api.webflow.com/oauth/access_token',
	required: true,
	scope: ['webhooks:write', 'forms:read'],
});

export const webflow = createQadam({
	displayName: 'Webflow',
	description: 'Design, build, and launch responsive websites visually',
	minimumSupportedRelease: '0.5.0',
	logoUrl: '/assets/qadams/webflow.png',
	categories: [QadamCategory.MARKETING],
	authors: [
		'Angelebeats',
		'Ahmad-AbuOsbeh',
		'TaskMagicKyle',
		'kishanprmr',
		'MoShizzle',
		'khaledmashaly',
		'abuaboud',
	],
	auth: webflowAuth,
	actions: [
		webflowCreateCollectionItemAction,
		webflowDeleteCollectionItem,
		webflowUpdateCollectionItem,
		webflowFindCollectionItem,
		webflowGetCollectionItem,
		webflowFulfillOrder,
		webflowUnfulfillOrder,
		webflowRefundOrder,
		webflowFindOrder,
		webflowPublishCollectionItem,
		webflowListSites,
		webflowListCollections,
		createCustomApiCallAction({
			baseUrl: () => 'https://api.webflow.com',
			auth: webflowAuth,
			authMapping: async (auth) => ({
				Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
			}),
		}),
	],
	triggers: [webflowNewSubmission],
});
