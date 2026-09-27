import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { allTools, ToolError, type ToolContent, type ToolContext } from "../tools/index.js";

function toMcpContent(content: ToolContent[]): CallToolResult["content"] {
  return content.map((c) =>
    c.type === "text"
      ? { type: "text" as const, text: c.text }
      : {
          type: "resource" as const,
          resource: { uri: `file:///${c.title ?? "document.pdf"}`, mimeType: "application/pdf", blob: c.base64 },
        },
  );
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "abrahamnavig-claude-tools", version: "0.1.0" });

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Clients such as Claude Desktop and Claude Code ask the user before running non-read-only tools.
        annotations: {
          readOnlyHint: tool.kind === "read",
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> => {
        try {
          return { content: toMcpContent(await tool.run(input as never, ctx)) };
        } catch (err) {
          const message = err instanceof ToolError ? err.message : `Unexpected error: ${(err as Error).message}`;
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    );
  }

  return server;
}
