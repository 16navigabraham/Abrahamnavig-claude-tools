import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultContentBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { allTools, type ToolContent, type ToolContext, type ToolDef } from "../tools/index.js";

export const DEFAULT_MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You are a document assistant inside the user's app. You can create, read, view and merge PDFs in the user's workspace with the tools provided.
All file paths are relative to the workspace. Use pdf_read for text and pdf_view when layout, tables, images or scanned pages matter.
Tools that create or change files ask the user for approval first. If the user declines, do not retry the same call; ask what they want instead.`;

/** Asked before any `kind: "write"` tool runs. Return true to allow it. */
export type ConfirmFn = (toolName: string, input: unknown) => Promise<boolean>;

export interface AgentOptions {
  client?: Anthropic;
  model?: string;
  workspace: string;
  confirm: ConfirmFn;
  tools?: ToolDef[];
  /** Called when a tool starts, for progress UI. */
  onToolCall?: (toolName: string, input: unknown) => void;
}

export interface AgentTurn {
  message: BetaMessage;
  /** The full conversation including this turn. Pass it back as `history` for the next turn. */
  history: BetaMessageParam[];
}

function toApiContent(content: ToolContent[]): BetaToolResultContentBlockParam[] {
  return content.map((c) =>
    c.type === "text"
      ? { type: "text", text: c.text }
      : {
          type: "document",
          title: c.title,
          source: { type: "base64", media_type: "application/pdf", data: c.base64 },
        },
  );
}

/** Wrap the shared tool definitions as runnable tools for the Claude API tool runner. */
export function toRunnableTools(tools: ToolDef[], ctx: ToolContext, confirm: ConfirmFn, onToolCall?: AgentOptions["onToolCall"]) {
  return tools.map((tool) =>
    betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (input) => {
        onToolCall?.(tool.name, input);
        if (tool.kind === "write" && !(await confirm(tool.name, input))) {
          return "The user declined this action. Nothing was changed.";
        }
        // Thrown errors are returned to Claude as is_error tool results by the runner.
        return toApiContent(await tool.run(input as never, ctx));
      },
    }),
  );
}

/** Run one user turn: Claude calls tools as needed and the final assistant message is returned. */
export async function runAgentTurn(
  userMessage: string,
  history: BetaMessageParam[],
  opts: AgentOptions,
): Promise<AgentTurn> {
  const client = opts.client ?? new Anthropic();
  const tools = toRunnableTools(opts.tools ?? allTools, { workspace: opts.workspace }, opts.confirm, opts.onToolCall);

  const runner = client.beta.messages.toolRunner({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    // If the primary model declines a request, the API retries it on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools,
    max_iterations: 20,
    messages: [...history, { role: "user", content: userMessage }],
  });

  const message = await runner.runUntilDone();
  const nextHistory = [...runner.params.messages];
  const last = nextHistory.at(-1);
  if (last?.role !== "assistant") nextHistory.push({ role: "assistant", content: message.content });
  return { message, history: nextHistory };
}

/** Concatenate the text blocks of a message, noting refusals and truncation. */
export function messageText(message: BetaMessage): string {
  const text = message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  if (message.stop_reason === "refusal") return text || "(Claude declined this request.)";
  if (message.stop_reason === "max_tokens") return `${text}\n\n(Response was cut off at the token limit.)`;
  return text;
}
