
import { createQadam } from "@aiqadam/qadams-framework";
import { askDeepseek } from "./lib/actions/ask-deepseek";
import { QadamCategory } from "@aiqadam/shared";
import { deepseekAuth } from './lib/auth';

        
    export const deepseek = createQadam({
      displayName: "DeepSeek",
      auth: deepseekAuth,
      categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
      minimumSupportedRelease: '0.36.1',
      logoUrl: "/assets/qadams/deepseek.png",
      authors: ["PFernandez98"],
      actions: [askDeepseek],
      triggers: [],
    });
    