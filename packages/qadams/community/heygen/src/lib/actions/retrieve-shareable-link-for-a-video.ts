import { createAction, Property } from '@aiqadam/qadams-framework';
import { HttpMethod } from '@aiqadam/qadams-common';
import { heygenApiCall } from '../common/client';
import { heygenAuth } from '../common/auth';

export const retrieveSharableVideoUrlAction = createAction({
  auth: heygenAuth,
  name: 'retrieve_sharable_video_url',
  displayName: 'Retrieve Sharable Video URL',
  description: 'Generates a public URL for a video, allowing it to be shared and accessed publicly.',
  audience: 'both',
  aiMetadata: {
    description: 'Enables public sharing for a finished video and returns a publicly accessible share URL, given the video ID. Use when an agent needs a link it can hand out without authentication. This is a server-side mutation that toggles the video to shareable, so treat it as not idempotent.',
    idempotent: false,
  },
  props: {
    videoId: Property.ShortText({
      displayName: 'Video ID',
      description: 'The ID of the video to generate a shareable URL for.',
      required: true,
    }),
  },
  async run({ propsValue, auth }) {
    const { videoId } = propsValue;

    const response = await heygenApiCall({
			apiKey: auth.secret_text,
      method: HttpMethod.POST,
      resourceUri: '/video/share',
      body: { video_id: videoId },
      apiVersion: 'v1',
    });

    return response;
  },
});
