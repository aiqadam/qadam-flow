import { QadamAuth } from '@aiqadam/qadams-framework';

export const mixpanelAuth = QadamAuth.SecretText({
  displayName: 'Mixpanel token',
  required: true,
  description: `
      The Mixpanel token associated with your project. You can find your Mixpanel token in the project settings dialog in the Mixpanel app.
    `,
});
