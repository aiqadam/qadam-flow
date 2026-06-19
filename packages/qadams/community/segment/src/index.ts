
import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { identifyUser } from "./lib/actions/identify-user";

export const segmentAuth = QadamAuth.SecretText({
  displayName: 'Analytics Key',
  required: true,
  description: 'Copy and paste your analytics write key here',
});


export const segment = createQadam({
  displayName: "Segment",
  auth: segmentAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: "/assets/qadams/segment.png",
  authors: ['abuaboud'],
  actions: [identifyUser],
  triggers: [],
});
