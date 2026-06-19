import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { generatePassword } from './lib/actions/generate-password';
import { hashText } from './lib/actions/hash-text';
import { hmacSignature } from './lib/actions/hmac-signature';
import { rsaSignature } from './lib/actions/rsa-signature';
import { base64Decode } from './lib/actions/base64-decode';
import { base64Encode } from './lib/actions/base64-encode';
import { openpgpEncrypt } from './lib/actions/openpgp-encrypt';

export const Crypto = createQadam({
  displayName: 'Crypto',
  description: 'Generate random passwords and hash existing text',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/new-core/crypto.svg',
  categories: [QadamCategory.CORE],
  authors: ['AbdullahBitar', 'kishanprmr', 'abuaboud', 'matthieu-lombard', 'antonyvigouret', 'danielpoonwj', 'prasanna2000-max'],
  actions: [hashText, hmacSignature, rsaSignature, generatePassword, base64Decode, base64Encode, openpgpEncrypt],
  triggers: [],
});
