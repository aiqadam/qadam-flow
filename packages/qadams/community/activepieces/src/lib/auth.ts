import { QadamAuth, Property } from '@aiqadam/qadams-framework';

const markdown = `
Qadam Flow Platform API is available for platform administrators.
(https://flow.aiqadam.org/docs/admin-console/overview)

**Note**: The API Key is available in the Platform Dashboard.

`;

export const activeQadamAuth = QadamAuth.CustomAuth({
  description: markdown,
  required: true,
  props: {
    baseApiUrl: Property.ShortText({
      displayName: 'Base URL',
      required: true,
      defaultValue: 'https://flow.aiqadam.org/api/v1',
    }),
    apiKey: QadamAuth.SecretText({
      displayName: 'API Key',
      required: true,
    }),
  },
});
