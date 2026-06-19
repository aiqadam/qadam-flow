
    import { createQadam } from "@aiqadam/qadams-framework";
    import { netlifyAuth } from "./lib/common/auth";
    import { startDeploy } from "./lib/actions/start-deploy";
    import { getSite } from "./lib/actions/get-site";
    import { listSiteDeploys } from "./lib/actions/list-site-deploys";
    import { listFiles } from "./lib/actions/list-files";
    import { newDeployStarted } from "./lib/triggers/new-deploy-started";
    import { newDeploySucceeded } from "./lib/triggers/new-deploy-succeeded";
    import { newDeployFailed } from "./lib/triggers/new-deploy-failed";
    import { newFormSubmission } from "./lib/triggers/new-form-submission";
import { QadamCategory } from "@aiqadam/shared";

    export const netlify = createQadam({
      displayName: "Netlify",
      auth: netlifyAuth,
      minimumSupportedRelease: '0.36.1',
      description: "Netlify is a platform for building and deploying websites and apps.",
      logoUrl: "/assets/qadams/netlify.png",
      authors: ["sparkybug"],
      categories: [QadamCategory.DEVELOPER_TOOLS],
      actions: [
        startDeploy,
        getSite,
        listSiteDeploys,
        listFiles,
      ],
      triggers: [
        newDeployStarted,
        newDeploySucceeded,
        newDeployFailed,
        newFormSubmission,
      ],
    });
    