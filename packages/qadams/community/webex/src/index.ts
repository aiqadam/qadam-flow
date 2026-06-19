import {
  createQadam,
  OAuth2PropertyValue,
} from '@aiqadam/qadams-framework';
import { createMessage } from './lib/actions/create-message';
import { createRoom } from './lib/actions/create-room';
import { createTeam } from './lib/actions/create-team';
import { findMessage } from './lib/actions/find-message';
import { findRoom } from './lib/actions/find-room';
import { webexAuth } from './lib/common/auth';
import { newRoom } from './lib/triggers/new-room';
import { newMeeting } from './lib/triggers/new-meeting';
import { QadamCategory } from '@aiqadam/shared';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { BASE_URL } from './lib/common/client';

export const webex = createQadam({
  displayName: 'Cisco Webex Meetings',
  auth: webexAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/webex.png',
  description: '',
  categories: [QadamCategory.COMMUNICATION],
  authors: ['sanket-a11y'],
  actions: [
    createMessage,
    createRoom,
    createTeam,
    findMessage,
    findRoom,
    createCustomApiCallAction({
      auth: webexAuth,
      baseUrl: () => BASE_URL,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  triggers: [newRoom, newMeeting],
});
