import { QadamAuth } from '@aiqadam/qadams-framework';

const markdownDescription = `
Please follow [Generate Long Live Token](https://developers.kommo.com/docs/long-lived-token) guide for generating token.

Your Kommo account subdomain (e.g., "mycompany" if your URL is mycompany.kommo.com).

`;

export const kommoAuth = QadamAuth.CustomAuth({
  description: markdownDescription,
  required: true,
  props: {
    subdomain: QadamAuth.SecretText({
      displayName: 'Subdomain',
      required: true,
    }),
    apiToken: QadamAuth.SecretText({
      displayName: 'Token',
      required: true,
    }),
  },
});
