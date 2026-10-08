import { QadamAuth, createQadam, QadamCategory } from '@aiqadam/qadams-framework';
import { httpSendRequestAction } from './lib/actions/send-http-request-action';
import { parseUrl } from './lib/actions/parse-url';

export const http = createQadam({
  displayName: 'HTTP',
  description: 'Sends HTTP requests and return responses',
  logoUrl: '/assets/qadams/new-core/http.svg',
  categories: [QadamCategory.CORE],
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.0.0',
  actions: [httpSendRequestAction, parseUrl],
  authors: [
    'bibhuty-did-this',
    'landonmoir',
    'JanHolger',
    'Salem-Alaa',
    'kishanprmr',
    'AbdulTheActivePiecer',
    'khaledmashaly',
    'abuaboud',
    'pfernandez98',
  ],
  triggers: [],
});
