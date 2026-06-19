import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  QadamAuth,
  Property,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { jotformCommon } from './lib/common';
import { newSubmission } from './lib/triggers/new-submission';

const markdownDescription = `
To obtain api key, follow the steps below:
1. Go to Settings -> API
2. Click on "Create New Key" button
3. Change the permissions to "Full Access"
4. Copy the API Key and paste it in the API Key field
`;

export const jotformAuth = QadamAuth.CustomAuth({
  required: true,
  description: markdownDescription,
  props: {
    apiKey: QadamAuth.SecretText({
      displayName: 'API Key',
      required: true,
    }),
    region: Property.StaticDropdown({
      displayName: 'Region',
      required: true,
      options: {
        options: [
          {
            label: 'US (api.jotform.com)',
            value: 'us',
          },
          {
            label: 'EU (eu-api.jotform.com)',
            value: 'eu',
          },
          {
            label: 'HIPAA (hipaa-api.jotform.com)',
            value: 'hipaa',
          },
        ],
      },
    }),
  },
});

export const jotform = createQadam({
  displayName: 'Jotform',
  description: 'Create online forms and surveys',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/jotform.svg',
  categories: [QadamCategory.FORMS_AND_SURVEYS],
  authors: ["kishanprmr","MoShizzle","khaledmashaly","abuaboud", "PFernandez98"],
  auth: jotformAuth,
  actions: [
    createCustomApiCallAction({
      baseUrl: (auth) =>
        auth?
        jotformCommon.baseUrl(auth.props.region) : '',
      auth: jotformAuth,
      authMapping: async (auth) => ({
        APIKEY: auth.props.apiKey,
      }),
    }),
  ],
  triggers: [newSubmission],
});
