import { pdfTools } from "./pdf.js";
import type { ToolDef } from "./types.js";

export * from "./types.js";
export { defaultWorkspace } from "./workspace.js";

/**
 * Every tool, shared by the MCP server and the Claude API agent.
 * To add a tool family (e.g. image generation/editing), create src/tools/<family>.ts and spread it here.
 */
export const allTools: ToolDef[] = [...pdfTools] as ToolDef[];
