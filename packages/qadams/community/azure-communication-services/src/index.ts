import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { sendEmail } from './lib/actions/send-email';
import { QadamCategory } from '@aiqadam/shared';

export const azureCommunicationServiceAuth = QadamAuth.SecretText({
  displayName: 'Connection string',
  required: true,
});

export const azureCommunicationServices = createQadam({
  displayName: 'Azure Communication Services',
  description: 'Communication services from Microsoft Azure',
  auth: azureCommunicationServiceAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl:
    '/assets/qadams/azure-communication-services.png',
  categories: [QadamCategory.COMMUNICATION, QadamCategory.MARKETING],
  authors: ['matthieu-lombard'],
  actions: [sendEmail],
  triggers: [],
});
