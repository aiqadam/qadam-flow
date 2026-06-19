import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createApprovalLink } from './lib/actions/create-approval-link';
import { waitForApprovalLink } from './lib/actions/wait-for-approval';

export const approval = createQadam({
  displayName: 'Approval (Legacy)',
  description: 'Build approval process in your workflows',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.82.0',
  logoUrl: '/assets/qadams/new-core/approvals.svg',
  authors: ["kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  categories: [QadamCategory.CORE, QadamCategory.FLOW_CONTROL],
  actions: [waitForApprovalLink, createApprovalLink],
  triggers: [],
});
