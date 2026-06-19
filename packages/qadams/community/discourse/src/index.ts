import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { addUsersToGroup } from './lib/actions/add-users-to-group.action';
import { changeUserTrustLevel } from './lib/actions/change-trust-level.action';
import { createPost } from './lib/actions/create-post.action';
import { createTopic } from './lib/actions/create-topic.action';
import { sendPrivateMessage } from './lib/actions/send-private-message.action';
import { discourseAuth } from './lib/auth';

export const discourse = createQadam({
  displayName: 'Discourse',
  description: 'Modern open source forum software',
  auth: discourseAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/discourse.png',
  categories: [QadamCategory.COMMUNICATION],
  authors: ["pfernandez98","kishanprmr","MoShizzle","abuaboud"],
  actions: [
    createPost,
    createTopic,
    changeUserTrustLevel,
    addUsersToGroup,
    sendPrivateMessage,
    createCustomApiCallAction({
      baseUrl: (auth) => auth ? (auth.props.website_url.trim()) : '',
      auth: discourseAuth,
      authMapping: async (auth) => ({
        'Api-Key': auth.props.api_key,
        'Api-Username': auth.props.api_username,
      }),
    }),
  ],
  triggers: [],
});
