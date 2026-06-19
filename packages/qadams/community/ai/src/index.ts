
import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { QadamCategory } from '@aiqadam/shared';
import { askAI } from './lib/actions/text/ask-ai';
import { summarizeText } from './lib/actions/text/summarize-text';
import { generateImageAction } from "./lib/actions/image/generate-image";
import { classifyText } from "./lib/actions/utility/classify-text";
import { extractStructuredData } from "./lib/actions/utility/extract-structured-data";
import { runAgent } from "./lib/actions/agents/run-agent";


export const ai = createQadam({
  displayName: "AI",
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.78.2',
  categories: [
    QadamCategory.ARTIFICIAL_INTELLIGENCE,
    QadamCategory.UNIVERSAL_AI,
  ],
  logoUrl: "/assets/qadams/new-core/text-ai.svg",
  authors: ['anasbarg', 'amrdb', 'Louai-Zokerburg'],
  actions: [askAI, summarizeText, generateImageAction, classifyText, extractStructuredData, runAgent],
  triggers: [],
});

export * from './lib/common/props';
export * from './lib/common/ai-sdk';