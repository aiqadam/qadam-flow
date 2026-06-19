import { httpClient, HttpMethod } from '@aiqadam/qadams-common';
import { QadamAuth } from '@aiqadam/qadams-framework';
import { BASE_URL } from './constants';

export const deepgramAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  required: true,
  description: `You can obtain your API key from [Deepgram Console](https://console.deepgram.com/).`,
  validate: async ({ auth }) => {
    try {
      await httpClient.sendRequest({
        method: HttpMethod.GET,
        url: BASE_URL + '/projects',
        headers: {
          Authorization: `Token ${auth}`,
        },
      });
      return { valid: true };
    } catch (e) {
      return { valid: false, error: 'Invalid API key.' };
    }
  },
});
