import { createQadam } from '@aiqadam/qadams-framework';
import { callMethod } from './lib/actions/call-method';
import { soapAuth } from './lib/shared/auth';

export const soap = createQadam({
  displayName: 'SOAP',
  description:
    'Simple Object Access Protocol for communication between applications',

  auth: soapAuth(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/soap.png',
  authors: ["x7airworker","kishanprmr","abuaboud"],
  categories: [],
  actions: [callMethod],
  triggers: [],
});
