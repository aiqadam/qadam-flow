
import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { convertTextToJson } from "./lib/actions/convert-text-to-json";
import { convertJsonToText } from "./lib/actions/convert-json-to-text";
import { runJsonataQuery } from "./lib/actions/run-jsonata-query";

export const jsonAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  required: true,
  description: 'Please use **test-key** as value for API Key',
});

export const json = createQadam({
  displayName: "JSON",
  description: "Convert JSON to text and vice versa",
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: "/assets/qadams/new-core/json-helper.svg",
  authors: ["leenmashni","abuaboud","bertrandong"],
  actions: [convertJsonToText, convertTextToJson, runJsonataQuery],
  triggers: [],
});
