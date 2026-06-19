import { propsValidation } from '@aiqadam/qadams-common';
import { createAction } from '@aiqadam/qadams-framework';
import { zohoCampaignsAuth, zohoCampaignsCommon } from '../common';

export const sendCampaign = createAction({
  auth: zohoCampaignsAuth,
  name: 'sendCampaign',
  displayName: 'Send Campaign',
  description: 'Send a campaign that has been created or cloned.',
  audience: 'both',
  aiMetadata: {
    description:
      'Sends an existing draft campaign (identified by its campaign key) to its configured mailing list recipients. Use after a campaign has been created or cloned and is ready to go out. Not idempotent and has an irreversible side effect: it dispatches email to subscribers.',
    idempotent: false,
  },
  props: zohoCampaignsCommon.sendCampaignProperties(),
  async run({ auth, propsValue }) {
    const location = auth.props?.['location'] as string || 'zoho.com';
    const accessToken = auth.access_token;
    await propsValidation.validateZod(
      propsValue,
      zohoCampaignsCommon.sendCampaignSchema
    );
    const { campaignkey } = propsValue;
    return await zohoCampaignsCommon.sendCampaign({
      accessToken,
      location,
      campaignkey: campaignkey as string,
    });
  },
});
