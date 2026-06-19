
    import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { manualTrigger } from "./lib/triggers/manual-trigger";
import { QadamCategory } from "@aiqadam/shared";

export const manualTriggerPiece = createQadam({
      displayName: "Manual Trigger",
      auth: QadamAuth.None(),
      minimumSupportedRelease: '0.78.0',
      logoUrl: "/assets/qadams/new-core/manual-trigger.svg",
      authors: ['AbdulTheActivePiecer'],
      actions: [],
      triggers: [manualTrigger],
      categories:[QadamCategory.CORE]
    });
    