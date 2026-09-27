import type { z } from "zod";

/** Content a tool returns. Kept transport-neutral so MCP and the Claude API can both render it. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "pdf"; base64: string; title?: string };

export interface ToolContext {
  /** Absolute directory every file path is resolved against. Tools never touch files outside it. */
  workspace: string;
}

/**
 * One tool definition shared by the MCP server and the Claude API agent.
 *
 * `kind: "write"` tools create or change files. The MCP server marks them non-read-only so the
 * client asks for approval, and the agent routes them through its confirmation callback.
 */
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  kind: "read" | "write";
  inputSchema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolContent[]>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export class ToolError extends Error {}
