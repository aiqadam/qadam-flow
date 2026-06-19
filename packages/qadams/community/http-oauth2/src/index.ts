import { createQadam, QadamAuth, Property } from "@aiqadam/qadams-framework";
import { httpOauth2RequestAction } from "./lib/actions/send-oauth2-http-request";

export const httpOauth2Auth = QadamAuth.OAuth2({
  description: 'OAuth2',
  authUrl: '{authUrl}',
  tokenUrl: '{tokenUrl}',
  required: true,
  scope: '{scopes}'.split(' '),
  grantType: 'both_client_credentials_and_authorization_code',
  props: {
    authUrl: Property.ShortText({
      displayName: 'Authorize URL',
      required: true,
      description: 'OAuth2 Authorize URL',
    }),
    tokenUrl: Property.ShortText({
      displayName: 'Token URL',
      required: true,
      description: 'OAuth2 Token URL',
    }),
    scopes: Property.ShortText({
      displayName: 'Scopes (whitespace separated)',
      required: true,
      description: 'OAuth2 Scopes',
    }),
  },
});

export const httpOauth2ClientCredentials = createQadam({
  displayName: "HTTP (OAuth2)",
  auth: httpOauth2Auth,
  minimumSupportedRelease: '0.56.0',
  logoUrl: "/assets/qadams/new-core/http.svg",
  authors: [
    'mhshiba'
  ],
  actions: [
    httpOauth2RequestAction,
  ],
  triggers: [],
});
