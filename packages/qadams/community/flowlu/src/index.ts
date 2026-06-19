import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createContactAction } from './lib/actions/accounts/create-contact';
import { createOrganizationAction } from './lib/actions/accounts/create-organization';
import { deleteContactAction } from './lib/actions/accounts/delete-contact';
import { updateContactAction } from './lib/actions/accounts/update-contact';
import { createOpportunityAction } from './lib/actions/opportunities/create-opportunity';
import { deleteOpportunityAction } from './lib/actions/opportunities/delete-opportunity';
import { updateOpportunityAction } from './lib/actions/opportunities/update-opportunity';
import { createTaskAction } from './lib/actions/tasks/create-task';
import { deleteTaskAction } from './lib/actions/tasks/delete-task';
import { getTaskAction } from './lib/actions/tasks/get-task';
import { updateTaskAction } from './lib/actions/tasks/update-task';
import { flowluAuth } from './lib/auth';

export const flowlu = createQadam({
  displayName: 'Flowlu',
  description: 'Business management software',
  auth: flowluAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/flowlu.png',
  categories: [QadamCategory.SALES_AND_CRM],
  authors: ["kishanprmr","abuaboud"],
  actions: [
    createContactAction,
    updateContactAction,
    deleteContactAction,
    createOrganizationAction,
    createOpportunityAction,
    updateOpportunityAction,
    deleteOpportunityAction,
    createTaskAction,
    updateTaskAction,
    getTaskAction,
    deleteTaskAction,
  ],
  triggers: [],
});
