import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { newEmail } from './lib/triggers/new-email';
import { imapAuth } from './lib/common';
import { markEmailAsRead } from './lib/actions/mark-email-read';
import { copyEmail } from './lib/actions/copy-email';
import { deleteEmail } from './lib/actions/delete-email';
import { moveEmail } from './lib/actions/move-email';

export const imapPiece = createQadam({
  displayName: 'IMAP',
  description: 'Receive new email trigger',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/imap.png',
  categories: [QadamCategory.BUSINESS_INTELLIGENCE],
  authors: ['kishanprmr', 'MoShizzle', 'khaledmashaly', 'abuaboud', 'simonc'],
  auth: imapAuth,
  actions: [
    markEmailAsRead,
    copyEmail,
    moveEmail,
    deleteEmail,
  ],
  triggers: [newEmail],
});
