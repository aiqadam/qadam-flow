import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { createTaskAction } from './lib/actions/create-task';
import { createTimeEntryAction } from './lib/actions/create-time-entry';
import { findRunningTimerAction } from './lib/actions/find-running-timer';
import { findTaskAction } from './lib/actions/find-task';
import { findTimeEntryAction } from './lib/actions/find-time-entry';
import { startTimerAction } from './lib/actions/start-timer';
import { stopTimerAction } from './lib/actions/stop-timer';
import { BASE_URL } from './lib/common/client';
import { newTaskTrigger } from './lib/triggers/new-task';
import { newTimeEntryTrigger } from './lib/triggers/new-time-entry';
import { newTimerStartedTrigger } from './lib/triggers/new-timer-started';
import { clockifyAuth } from './lib/auth';

export const clockify = createQadam({
	displayName: 'Clockify',
	auth: clockifyAuth,
	minimumSupportedRelease: '0.36.1',
	logoUrl: '/assets/qadams/clockify.png',
	authors: ['rimjhimyadav', 'kishanprmr'],
	actions: [
		createTaskAction,
		createTimeEntryAction,
		startTimerAction,
		stopTimerAction,
		findTaskAction,
		findTimeEntryAction,
		findRunningTimerAction,
		createCustomApiCallAction({
			auth: clockifyAuth,
			baseUrl: () => BASE_URL,
			authMapping: async (auth) => {
				return {
					'X-Api-Key': auth.secret_text,
				};
			},
		}),
	],
	triggers: [newTaskTrigger, newTimeEntryTrigger, newTimerStartedTrigger],
});
