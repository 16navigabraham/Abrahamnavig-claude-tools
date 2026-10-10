import { csvTools } from "./csv.js";
import { fileTools } from "./files.js";
import { imageTools } from "./image.js";
import { pdfTools } from "./pdf.js";
import { qrTools } from "./qr.js";
import type { ToolDef } from "./types.js";

export * from "./types.js";
export { defaultWorkspace } from "./workspace.js";

/**
 * Every tool, shared by the MCP server and the Claude API agent.
 * To add a tool family, create src/tools/<family>.ts and spread it into this array.
 */
export const allTools: ToolDef[] = [...pdfTools, ...fileTools, ...imageTools, ...qrTools, ...csvTools] as ToolDef[];
