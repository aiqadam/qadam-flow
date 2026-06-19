import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { getGraphBaseUrl } from './lib/common/microsoft-cloud';
import { createQadam, OAuth2PropertyValue } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { addLabelToEmailAction } from './lib/actions/add-label-to-email';
import { createDraftEmailAction } from './lib/actions/create-draft-email';
import { downloadAttachmentAction } from './lib/actions/download-email-attachment';
import { findEmailAction } from './lib/actions/find-email';
import { forwardEmailAction } from './lib/actions/forward-email';
import { moveEmailToFolderAction } from './lib/actions/move-email-to-folder';
import { removeLabelFromEmailAction } from './lib/actions/remove-label-from-email';
import { replyEmailAction } from './lib/actions/reply-email';
import { sendDraftEmailAction } from './lib/actions/send-draft-email';
import { sendEmailAction } from './lib/actions/send-email';
import { microsoftOutlookAuth } from './lib/common/auth';
import { newAttachmentTrigger } from './lib/triggers/new-attachment';
import { newEmailInFolderTrigger } from './lib/triggers/new-email-in-folder';
import { newEmailTrigger } from './lib/triggers/new-email';
import { requestApprovalInMail } from './lib/actions/request-approval-send-email';

export const microsoftOutlook = createQadam({
	displayName: 'Microsoft Outlook',
	auth: microsoftOutlookAuth,
	minimumSupportedRelease: '0.82.0',
	logoUrl: '/assets/qadams/microsoft-outlook.png',
	categories: [QadamCategory.PRODUCTIVITY],
	authors: ['lucaslimasouza', 'kishanprmr', 'sanket-a11y'],
	actions: [
		sendEmailAction,
		downloadAttachmentAction,
		replyEmailAction,
		createDraftEmailAction,
		addLabelToEmailAction,
		removeLabelFromEmailAction,
		requestApprovalInMail,
		moveEmailToFolderAction,
		sendDraftEmailAction,
		forwardEmailAction,
		findEmailAction,
		createCustomApiCallAction({
			auth: microsoftOutlookAuth,
			baseUrl: (auth) => {
				const cloud = (auth as OAuth2PropertyValue).props?.['cloud'] as string | undefined;
				return getGraphBaseUrl(cloud) + '/v1.0/';
			},
			authMapping: async (auth) => ({
				Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
			}),
		}),
	],
	triggers: [
		newEmailTrigger,
		newEmailInFolderTrigger,
		newAttachmentTrigger,
	],
});
