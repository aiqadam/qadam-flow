import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { twilioSendSms } from './lib/action/send-sms';
import { twilioNewIncomingSms } from './lib/trigger/new-incoming-sms';
import { twilioPhoneNumberLookup } from './lib/action/phone-number-lookup';
import { twilioMakeCall } from './lib/action/make-call';
import { twilioGetMessage } from './lib/action/get-message';
import { twilioDownloadRecordingMedia } from './lib/action/download-recording-media';
import { twilioNewPhoneNumber } from './lib/trigger/new-phone-number';
import { twilioNewRecording } from './lib/trigger/new-recording';
import { twilioNewTranscription } from './lib/trigger/new-transcription';
import { twilioNewCall } from './lib/trigger/new-call';

export const twilioAuth = QadamAuth.BasicAuth({
  description: 'The authentication to use to connect to Twilio',

  required: true,
  username: {
    displayName: 'Account SID',
    description: 'The account SID to use to connect to Twilio',
  },
  password: {
    displayName: 'Auth token',
    description: 'The auth token to use to connect to Twilio',
  },
});

export const twilio = createQadam({
  displayName: 'Twilio',
  description:
    'Cloud communications platform for building SMS, Voice & Messaging applications',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/twilio.png',
  auth: twilioAuth,
  categories: [QadamCategory.COMMUNICATION],
  actions: [
    twilioSendSms,
    twilioPhoneNumberLookup,
    twilioMakeCall,
    twilioGetMessage,
    twilioDownloadRecordingMedia,
    createCustomApiCallAction({
      baseUrl: () => 'https://api.twilio.com/2010-04-01',
      auth: twilioAuth,
      authMapping: async (auth) => ({
        Authorization: `Basic ${Buffer.from(
          `${auth.username}:${
            auth.password
          }`
        ).toString('base64')}`,
      }),
    }),
  ],
  authors: ["kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  triggers: [twilioNewIncomingSms,
    twilioNewPhoneNumber,
    twilioNewRecording,
    twilioNewTranscription,
    twilioNewCall
  ],
});
