import { QadamAuth, Property } from '@aiqadam/qadams-framework';

export const stableDiffusionAuth = QadamAuth.CustomAuth({
  required: true,
  props: {
    baseUrl: Property.ShortText({
      displayName: 'Stable Diffusion web UI API base URL',
      required: true,
    }),
  },
});
