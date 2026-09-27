#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { defaultWorkspace } from "../tools/index.js";
import { messageText, runAgentTurn } from "./agent.js";

const rl = readline.createInterface({ input, output });
const workspace = defaultWorkspace();

async function confirm(toolName: string, toolInput: unknown): Promise<boolean> {
  console.log(`\nClaude wants to run ${toolName}:\n${JSON.stringify(toolInput, null, 2)}`);
  const answer = await rl.question("Allow? [y/N] ");
  return answer.trim().toLowerCase().startsWith("y");
}

console.log(`Claude tools agent. Workspace: ${workspace}\nType a request, or "exit" to quit.\n`);

let history: BetaMessageParam[] = [];
for (;;) {
  const line = (await rl.question("> ")).trim();
  if (!line) continue;
  if (line === "exit" || line === "quit") break;
  try {
    const turn = await runAgentTurn(line, history, {
      workspace,
      model: process.env.CLAUDE_MODEL,
      confirm,
      onToolCall: (name) => console.log(`  [tool] ${name}`),
    });
    history = turn.history;
    console.log(`\n${messageText(turn.message)}\n`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\n`);
  }
}
rl.close();
