import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  QadamAuth,
  Property,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { sendMessage } from './lib/actions/send-message';

const markdownDescription = `
**Workspace URL**: The url of mattermost instance (e.g \`https://activepieces.mattermost.com\`)

**Bot Token**: Obtain it from settings > integrations > bot accounts > add bot account
`;

export const mattermostAuth = QadamAuth.CustomAuth({
  description: markdownDescription,
  required: true,
  props: {
    workspace_url: Property.ShortText({
      displayName: 'Workspace URL',
      description:
        'The workspace URL of the Mattermost instance (e.g https://activepieces.mattermost.com)',
      required: true,
    }),
    token: Property.ShortText({
      displayName: 'Bot Token',
      description: 'The bot token to use to authenticate',
      required: true,
    }),
  },
});

export const mattermost = createQadam({
  displayName: 'Mattermost',
  description: 'Open-source, self-hosted Slack alternative',

  logoUrl: '/assets/qadams/mattermost.png',
  minimumSupportedRelease: '0.30.0',
  categories: [QadamCategory.COMMUNICATION],
  authors: ["kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  auth: mattermostAuth,
  actions: [
    sendMessage,
    createCustomApiCallAction({
          baseUrl: (auth) =>auth ?
        (auth.props.workspace_url) + '/api/v4' : '',
      auth: mattermostAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth ).props .token}`,
      }),
    }),
  ],
  triggers: [],
});
