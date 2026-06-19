import {
  createQadam,
} from '@aiqadam/qadams-framework';
import actions from './lib/actions';
import { odooAuth } from './lib/auth';

export const odoo = createQadam({
  displayName: 'Odoo',
  description: 'Open source all-in-one management software',
  auth: odooAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/odoo.png',
  authors: ["mariomeyer","kishanprmr","abuaboud"],
  actions,
  triggers: [],
});
