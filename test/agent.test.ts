import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageText, runAgentTurn } from "../src/agent/agent.js";

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-agent-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** A Claude API stand-in: first asks to create a PDF, then replies with text. Records request bodies. */
function fakeClient() {
  const requests: any[] = [];
  const reply = (content: unknown[], stop_reason: string) =>
    new Response(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content,
        stop_reason,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? reply(
          [{ type: "tool_use", id: "tu_1", name: "pdf_create", input: { path: "a.pdf", content: "Agent made this" } }],
          "tool_use",
        )
      : reply([{ type: "text", text: "Done." }], "end_turn");
  });
  return { client: new Anthropic({ apiKey: "test", fetch: fetch as never, maxRetries: 0 }), requests };
}

describe("runAgentTurn", () => {
  it("runs write tools after confirmation and returns history", async () => {
    const { client, requests } = fakeClient();
    const confirm = vi.fn(async () => true);
    const turn = await runAgentTurn("make a pdf", [], { client, workspace, confirm });

    expect(confirm).toHaveBeenCalledWith("pdf_create", expect.objectContaining({ path: "a.pdf" }));
    await expect(fs.stat(path.join(workspace, "a.pdf"))).resolves.toBeDefined();
    expect(messageText(turn.message)).toBe("Done.");
    expect(turn.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    expect(requests[0]).toMatchObject({ model: "claude-opus-5", fallbacks: "default", thinking: { type: "adaptive" } });
    expect(requests[1].messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });

  it("does not touch files when the user declines", async () => {
    const { client, requests } = fakeClient();
    await runAgentTurn("make a pdf", [], { client, workspace, confirm: async () => false });

    await expect(fs.stat(path.join(workspace, "a.pdf"))).rejects.toThrow();
    expect(JSON.stringify(requests[1].messages[2].content)).toContain("declined");
  });
});
