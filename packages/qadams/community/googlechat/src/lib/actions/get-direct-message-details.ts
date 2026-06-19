import { createAction } from '@aiqadam/qadams-framework';
import { propsValidation } from '@aiqadam/qadams-common';
import { googleChatApiAuth, googleChatCommon } from '../common';
import { directMessagesDropdown } from '../common/props';
import { googleChatAPIService } from '../common/requests';

export const getDirectMessageDetails = createAction({
  auth: googleChatApiAuth,
  name: 'getDirectMessageDetails',
  displayName: 'Get Direct Message Details',
  description: 'Retrieve details of a specific direct message by ID.',
  audience: 'both',
  aiMetadata: {
    description: 'Fetches the details of a direct-message space in Google Chat by its space/DM ID. Use to look up a one-on-one conversation. Read-only and idempotent.',
    idempotent: true,
  },
  props: {
    directMessageId: directMessagesDropdown({ refreshers: ['auth'], required: true }),
  },
  async run({ auth, propsValue }) {
    await propsValidation.validateZod(propsValue, googleChatCommon.getDirectMessageDetailsSchema);

    const { directMessageId } = propsValue;

    const response = await googleChatAPIService.getSpace({
      accessToken: auth.access_token,
      spaceId: directMessageId as string,
    });

    return response;
  },
});
