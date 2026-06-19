import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { replyToMcpClient } from "./lib/actions/reply-to-mcp-client";
import { mcpTool } from "./lib/triggers/mcp-tool";
import { QadamCategory } from "@aiqadam/shared";

export const mcp = createQadam({
  displayName: "MCP",
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.50.2',
  logoUrl: "/assets/qadams/new-core/mcp.svg",
  authors: ['Gamal72', 'hazemadelkhalel'],
  description: 'Connect to your hosted MCP Server using any MCP client to communicate with tools',
  actions: [replyToMcpClient],
  triggers: [mcpTool],
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE,QadamCategory.UNIVERSAL_AI]
});
