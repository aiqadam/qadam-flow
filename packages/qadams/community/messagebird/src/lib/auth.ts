import { QadamAuth } from '@aiqadam/qadams-framework';

export interface BirdAuthValue {
  apiKey: string;
  workspaceId: string;
  channelId: string;
}

export const birdAuth = QadamAuth.CustomAuth({
  props: {
    apiKey: QadamAuth.SecretText({
      displayName: 'API Key',
      description: 'Bird API Access Key from Settings > Security > Access Keys',
      required: true,
    }),
    workspaceId: QadamAuth.SecretText({
      displayName: 'Workspace ID',
      description: 'Bird Workspace ID found in your workspace URL',
      required: true,
    }),
    channelId: QadamAuth.SecretText({
      displayName: 'Channel ID',
      description: 'Your SMS channel ID from Bird dashboard',
      required: true,
    }),
  },
  required: true,
}); 