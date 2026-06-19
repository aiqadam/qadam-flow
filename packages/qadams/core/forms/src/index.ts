import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { onChatSubmission } from './lib/triggers/chat-trigger';
import { onFormSubmission } from './lib/triggers/form-trigger';
import { returnResponse } from './lib/actions/return-response';

export const forms = createQadam({
  displayName: 'Human Input',
  description: 'Trigger a flow through human input.',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.65.0',
  categories: [QadamCategory.CORE],
  logoUrl: '/assets/qadams/new-core/human-input.svg',
  authors: ['anasbarg', 'MoShizzle', 'abuaboud'],
  actions: [returnResponse],
  triggers: [onFormSubmission, onChatSubmission],
});
