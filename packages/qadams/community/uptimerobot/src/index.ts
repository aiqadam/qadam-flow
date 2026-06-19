import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { uptimeRobotAuth } from './lib/auth';
import { getMonitorsAction } from './lib/actions/get-monitors';
import { createMonitorAction } from './lib/actions/create-monitor';
import { editMonitorAction } from './lib/actions/edit-monitor';
import { deleteMonitorAction } from './lib/actions/delete-monitor';
import { pauseResumeMonitorAction } from './lib/actions/pause-resume-monitor';

export const uptimeRobot = createQadam({
  displayName: 'UptimeRobot',
  description: 'Monitor your websites, APIs, and servers. Get alerted when things go down.',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/uptimerobot.png',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  auth: uptimeRobotAuth,
  authors: ['majewskibartosz'],
  actions: [
    getMonitorsAction,
    createMonitorAction,
    editMonitorAction,
    deleteMonitorAction,
    pauseResumeMonitorAction,
  ],
  triggers: [],
});
