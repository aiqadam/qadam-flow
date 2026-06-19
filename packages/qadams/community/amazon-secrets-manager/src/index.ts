import { createQadam } from '@aiqadam/qadams-framework';
import { awsSecretsManagerAuth } from './lib/common/auth';
import { getSecretValue } from './lib/actions/get-secret-value';
import { updateSecret } from './lib/actions/update-secret';
import { createSecret } from './lib/actions/create-secret';
import { deleteSecret } from './lib/actions/delete-secret';
import { findSecret } from './lib/actions/find-secret';
import { getARandomPassword } from './lib/actions/get-a-random-password';
import { QadamCategory } from '@aiqadam/shared';

export const amazonSecretsManager = createQadam({
  displayName: 'AWS Secrets Manager',
  auth: awsSecretsManagerAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/amazon-secrets-manager.png',
  authors: ['sanket-a11y'],
  categories: [QadamCategory.DEVELOPER_TOOLS],
  actions: [
    createSecret,
    getSecretValue,
    updateSecret,
    deleteSecret,
    findSecret,
    getARandomPassword,
  ],
  triggers: [],
});
