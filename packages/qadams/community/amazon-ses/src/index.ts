import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { sendEmail } from './lib/actions/send-email';
import { createEmailTemplate } from './lib/actions/create-email-template';
import { sendTemplatedEmail } from './lib/actions/send-templated-email';
import { updateEmailTemplate } from './lib/actions/update-email-template';
import { createCustomVerificationEmailTemplate } from './lib/actions/create-custom-verification-email-template';
import { sendCustomVerificationEmail } from './lib/actions/send-custom-verification-email';
import { updateCustomVerificationEmailTemplate } from './lib/actions/update-custom-verification-email-template';
import { amazonSesAuth } from './lib/auth';

export const amazonSes = createQadam({
  displayName: 'Amazon SES',
  auth: amazonSesAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/amazon-ses.png',
  authors: ["fortunamide"],
  actions: [
    sendEmail,
    createEmailTemplate,
    sendTemplatedEmail,
    updateEmailTemplate,
    createCustomVerificationEmailTemplate,
    sendCustomVerificationEmail,
    updateCustomVerificationEmailTemplate,
  ],
  triggers: [],
});
