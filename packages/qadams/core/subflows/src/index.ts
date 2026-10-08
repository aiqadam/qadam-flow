import { createQadam, QadamAuth, QadamCategory } from '@aiqadam/qadams-framework';
import { callFlow } from './lib/actions/call-flow';
import { callFlowForEach } from './lib/actions/call-flow-for-each';
import { callableFlow } from './lib/triggers/callable-flow';
import { response } from './lib/actions/respond';

export const flows = createQadam({
  displayName: 'Sub Flows',
  description: 'Trigger and call another sub flow.',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.0.0',
  categories: [QadamCategory.CORE, QadamCategory.FLOW_CONTROL],
  logoUrl: '/assets/qadams/new-core/subflows.svg',
  authors: ['hazemadelkhalel'],
  actions: [callFlow, callFlowForEach, response],
  triggers: [callableFlow],
});
