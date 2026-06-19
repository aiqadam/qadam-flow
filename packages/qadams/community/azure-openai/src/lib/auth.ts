import { QadamAuth, Property } from '@aiqadam/qadams-framework';

export const azureOpenaiAuth = QadamAuth.CustomAuth({
  props: {
    endpoint: Property.ShortText({
      displayName: 'Endpoint',
      description: 'https://<resource name>.openai.azure.com/',
      required: true,
    }),
    apiKey: QadamAuth.SecretText({
      displayName: 'API Key',
      description:
        'Use the Azure Portal to browse to your OpenAI resource and retrieve an API key',
      required: true,
    }),
  },
  required: true,
});
