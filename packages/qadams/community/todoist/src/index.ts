import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { todoistCreateTaskAction } from './lib/actions/create-task-action';
import { todoistTaskCompletedTrigger } from './lib/triggers/task-completed-trigger';
import { todoistUpdateTaskAction } from './lib/actions/update-task.action';
import { todoistFindTaskAction } from './lib/actions/find-task.action';
import { todoistMarkTaskCompletedAction } from './lib/actions/mark-task-completed.action';

export const todoistAuth = QadamAuth.OAuth2({
	required: true,
	authUrl: 'https://todoist.com/oauth/authorize',
	tokenUrl: 'https://todoist.com/oauth/access_token',
	scope: ['data:read_write'],
});

export const todoist = createQadam({
	displayName: 'Todoist',
	description: 'To-do list and task manager',
	minimumSupportedRelease: '0.5.0',
	logoUrl: '/assets/qadams/todoist.png',
	authors: ['MyWay', 'kishanprmr', 'MoShizzle', 'khaledmashaly', 'abuaboud','sanket-a11y'],
	categories: [QadamCategory.PRODUCTIVITY],
	auth: todoistAuth,
	actions: [
		todoistCreateTaskAction,
		todoistUpdateTaskAction,
		todoistFindTaskAction,
		todoistMarkTaskCompletedAction,
		createCustomApiCallAction({
			baseUrl: () => 'https://api.todoist.com/api/v1',
			auth: todoistAuth,
			authMapping: async (auth) => ({
				Authorization: `Bearer ${auth.access_token}`,
			}),
		}),
	],
	triggers: [todoistTaskCompletedTrigger],
});
