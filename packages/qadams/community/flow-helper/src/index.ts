import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { getRunId } from "./lib/actions/get-run-id";
import { failFlow } from "./lib/actions/fail-flow";
import { stopFlow } from "./lib/actions/stop-flow";

export const flowHelper = createQadam({
  displayName: "Flow Helper",
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.36.1',
  logoUrl: "/assets/qadams/flow-helper.svg",
  authors: ["AbdulTheActivePiecer","AnkitSharmaOnGithub"],
  actions: [getRunId, failFlow, stopFlow],
  triggers: [],
});
