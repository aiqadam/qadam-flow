import { createQadam } from '@aiqadam/qadams-framework';
import { websocketCommon } from './lib/common/common';
import { websocketSubscriptionTrigger } from './lib/triggers/websocket-subscription-trigger';

export const anyHookWebsocket = createQadam({
  displayName: 'AnyHook Websocket',
  description:
    'AnyHook Websocket enables real-time communication through AnyHook proxy server by allowing you to subscribe and listen to websocket events',
  auth: websocketCommon.auth,
  minimumSupportedRelease: '0.20.0',
  logoUrl:
    '/assets/qadams/anyhook-websocket.png',
  authors: ['Swanblocks/Ahmad Shawar'],
  actions: [],
  triggers: [
    websocketSubscriptionTrigger,
  ],
});
