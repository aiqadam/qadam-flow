import { createQadam } from '@aiqadam/qadams-framework';
import { graphqlCommon } from './lib/common/common';
import { graphqlSubscriptionTrigger } from './lib/triggers/graphql-subscription-trigger';

export const anyHookGraphql = createQadam({
  displayName: 'AnyHook GraphQL',
  description:
    'AnyHook GraphQL enables real-time communication through AnyHook proxy server by allowing you to subscribe and listen to GraphQL subscription events',
  auth: graphqlCommon.auth,
  minimumSupportedRelease: '0.20.0',
  logoUrl:
    '/assets/qadams/anyhook-graphql.png',
  authors: ['ahmad-swanblocks'],
  actions: [],
  triggers: [
    graphqlSubscriptionTrigger,
  ],
});
