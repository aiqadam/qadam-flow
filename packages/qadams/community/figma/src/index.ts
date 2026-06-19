import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  OAuth2PropertyValue,
  createQadam,
} from '@aiqadam/qadams-framework';
import { getCommentsAction } from './lib/actions/get-comments-action';
import { getFileAction } from './lib/actions/get-file-action';
import { postCommentAction } from './lib/actions/post-comment-action';
import { newCommentTrigger } from './lib/trigger/new-comment';
import { figmaAuth } from './lib/auth';

export const figma = createQadam({
  displayName: 'Figma',
  description: 'Collaborative interface design tool',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/figma.png',
  categories: [],
  authors: ["kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  auth: figmaAuth,
  actions: [
    getFileAction,
    getCommentsAction,
    postCommentAction,
    createCustomApiCallAction({
      baseUrl: () => 'https://api.figma.com',
      auth: figmaAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  triggers: [newCommentTrigger],
});
