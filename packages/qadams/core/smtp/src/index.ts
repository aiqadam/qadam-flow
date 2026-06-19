import {
  QadamAuth,
  Property,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { sendEmail } from './lib/actions/send-email';
import { smtpCommon } from './lib/common';

const SMTPPorts = [25, 465, 587, 2525];

export const smtpAuth = QadamAuth.CustomAuth({
  required: true,
  props: {
    host: Property.ShortText({
      displayName: 'Host',
      required: true,
    }),
    email: Property.ShortText({
      displayName: 'Email',
      description: 'Leave blank if your mail relay does not require authentication.',
      required: false,
    }),
    password: QadamAuth.SecretText({
      displayName: 'Password',
      description: 'Leave blank if your mail relay does not require authentication.',
      required: false,
    }),
    port: Property.StaticDropdown({
      displayName: 'Port',
      required: true,
      options: {
        disabled: false,
        options: SMTPPorts.map((port) => {
          return {
            label: port.toString(),
            value: port,
          };
        }),
      },
    }),
    TLS: Property.Checkbox({
      displayName: 'Require TLS?',
      defaultValue: false,
      required: true,
    }),
  },
  validate: async ({ auth }) => {
        try {
      const transporter = smtpCommon.createSMTPTransport(auth);
      return new Promise((resolve, reject) => {
        transporter.verify(function (error, success) {
          if (error) {
            resolve({ valid: false, error: JSON.stringify(error) });
          } else {
            resolve({ valid: true });
          }
        });
      });
    } catch (e) {
      const castedError = (e as Record<string, unknown>)
      const code = castedError?.['code'];
      switch (code) {
        case 'EDNS':
          return {
            valid: false,
            error: 'SMTP server not found or unreachable with error code: EDNS',
          };
        case 'CONN':
          return {
            valid: false,
            error: 'SMTP server connection failed with error code: CONN',
          };
        default:
          break;
      }
      return {
        valid: false,
        error: JSON.stringify(e),
      };
    }
  },
});

export const smtp = createQadam({
  displayName: 'SMTP',
  description: 'Send emails using Simple Mail Transfer Protocol',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/new-core/smtp.svg',
  categories: [QadamCategory.CORE],
  authors: [
    'tahboubali',
    'abaza738',
    'kishanprmr',
    'MoShizzle',
    'khaledmashaly',
    'abuaboud',
    'pfernandez98'
  ],
  auth: smtpAuth,
  actions: [sendEmail],
  triggers: [],
});
