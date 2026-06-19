import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { completeTaskAction } from './lib/actions/complete-task';
import { createTaskAction } from './lib/actions/create-task';
import { deleteTaskAction } from './lib/actions/delete-task';
import { findTaskAction } from './lib/actions/find-task';
import { getProjectAction } from './lib/actions/get-project-by-id';
import { getTaskAction } from './lib/actions/get-task';
import { updateTaskAction } from './lib/actions/update-task';
import { newTaskCreatedTrigger } from './lib/triggers/new-task-created';
import { ticktickAuth } from './lib/auth';

export const ticktick = createQadam({
	displayName: 'TickTick',
	logoUrl: '/assets/qadams/ticktick.png',
	auth: ticktickAuth,
	authors: ['onyedikachi-david', 'kishanprmr'],
	actions: [
		createTaskAction,
    updateTaskAction,
    getTaskAction,
    deleteTaskAction,
    completeTaskAction,
    findTaskAction,
    getProjectAction,
    createCustomApiCallAction({
      auth:ticktickAuth,
      baseUrl:()=>'https://api.ticktick.com/open/v1',
      authMapping:async (auth)=>{
        return {
          Authorization:`Bearer ${(auth).access_token}`
        }
      }
    })
	],
	triggers: [newTaskCreatedTrigger],
});
