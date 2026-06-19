import { QadamAuth } from '@aiqadam/qadams-framework';

export const huggingFaceAuth = QadamAuth.SecretText({
  displayName: 'API Token',
  description:
    'Your Hugging Face API token (get it from https://huggingface.co/settings/tokens)',
  required: true,
});
