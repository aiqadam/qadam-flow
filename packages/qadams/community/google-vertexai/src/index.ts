import { createQadam } from "@aiqadam/qadams-framework";
import { QadamCategory } from "@aiqadam/shared";
import { vertexAiAuth } from "./lib/auth";
import { generateContent, generateImage, customApiCall } from "./lib/actions";

export const googleVertexai = createQadam({
  displayName: "Google Vertex AI",
  description: "Generate content and images using Gemini and Imagen models on Google Vertex AI.",
  auth: vertexAiAuth,
  minimumSupportedRelease: "0.71.4",
  logoUrl: "/assets/qadams/google-vertexai.png",
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  authors: ["alinperghel", "onyedikachi-david","bertrandong"],
  actions: [generateContent, generateImage, customApiCall],
  triggers: [],
});

export { vertexAiAuth, GoogleVertexAIAuthValue } from "./lib/auth";
