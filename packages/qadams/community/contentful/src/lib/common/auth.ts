import { QadamAuth, Property } from '@aiqadam/qadams-framework';

export interface ContentfulAuth {
  apiKey: string;
  environment: string;
  space: string;
}

export const ContentfulAuth = QadamAuth.CustomAuth({
  required: true,
  props: {
    apiKey: Property.ShortText({
      displayName: 'Contentful Access Token',
      required: true,
    }),
    space: Property.ShortText({
      displayName: 'Space',
      required: true,
    }),
    environment: Property.ShortText({
      displayName: 'Environment',
      required: true,
    }),
  },
});
