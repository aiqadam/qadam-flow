import { propsValidation } from '@aiqadam/qadams-common';
import { createAction } from '@aiqadam/qadams-framework';
import { zohoCampaignsAuth, zohoCampaignsCommon } from '../common';

export const removeTag = createAction({
  auth: zohoCampaignsAuth,
  name: 'removeTag',
  displayName: 'Remove Tag',
  description: 'Remove a tag from a contact.',
  audience: 'both',
  aiMetadata: {
    description:
      'Removes a tag from a contact. Use to unlabel or de-segment a subscriber. Idempotent: once the tag is gone, repeating the call leaves the contact in the same untagged state.',
    idempotent: true,
  },
  props: zohoCampaignsCommon.removeTagProperties,
  async run({ auth, propsValue }) {
    const location = auth.props?.['location'] as string || 'zoho.com';
    const accessToken = auth.access_token;
    await propsValidation.validateZod(
      propsValue,
      zohoCampaignsCommon.removeTagSchema
    );
    return await zohoCampaignsCommon.removeTag({
      accessToken,
      location,
      ...propsValue,
    });
  },
});
