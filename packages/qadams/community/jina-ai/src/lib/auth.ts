import { QadamAuth } from '@aiqadam/qadams-framework';

const markdownDescription = `
You can get your API key from [Jina AI](https://jina.ai).
`;

export const jinaAiAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  description: markdownDescription,
  required: true,
})
