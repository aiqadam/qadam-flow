import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { callFlow } from './lib/actions/call-flow';
import { callableFlow } from './lib/triggers/callable-flow';
import { response } from './lib/actions/respond';
import { QadamCategory } from '@aiqadam/shared';

export const flows = createQadam({
  displayName: 'Sub Flows',
  description: 'Trigger and call another sub flow.',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.82.0',
  categories: [QadamCategory.CORE, QadamCategory.FLOW_CONTROL],
  logoUrl: '/assets/qadams/new-core/subflows.svg',
  authors: ['hazemadelkhalel'],
  actions: [callFlow, response],
  triggers: [callableFlow],
});
