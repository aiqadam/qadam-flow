import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  OAuth2PropertyValue,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { googleTasksAddNewTaskAction } from './lib/actions/new-task';
import { googleTasksCommon } from './lib/common';
import { newTaskTrigger } from './lib/triggers/new-task';
import { googleTasksAuth } from './lib/auth';

export const googleTasks = createQadam({
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/google-tasks.png',
  categories: [QadamCategory.PRODUCTIVITY],
  actions: [
    googleTasksAddNewTaskAction,
    createCustomApiCallAction({
      baseUrl: () => googleTasksCommon.baseUrl,
      auth: googleTasksAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  displayName: 'Google Tasks',
  description: 'Task list management application',

  authors: ["Salem-Alaa","kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  triggers: [newTaskTrigger],
  auth: googleTasksAuth,
});
