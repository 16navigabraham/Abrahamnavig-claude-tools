import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

let workspace: string;
let client: Client;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-mcp-"));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer({ workspace }).connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
});
afterAll(async () => {
  await client.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("lists tools with read-only hints", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["pdf_create", "pdf_info", "pdf_merge", "pdf_read", "pdf_view"]);
    expect(byName.pdf_read.annotations?.readOnlyHint).toBe(true);
    expect(byName.pdf_create.annotations?.readOnlyHint).toBe(false);
    expect(byName.pdf_create.inputSchema.properties).toHaveProperty("content");
  });

  it("creates, reads and views a PDF", async () => {
    const created = await client.callTool({ name: "pdf_create", arguments: { path: "doc.pdf", content: "Hi MCP" } });
    expect(created.isError).toBeFalsy();

    const read = await client.callTool({ name: "pdf_read", arguments: { path: "doc.pdf" } });
    expect(JSON.stringify(read.content)).toContain("Hi MCP");

    const view = (await client.callTool({ name: "pdf_view", arguments: { path: "doc.pdf" } })) as {
      content: Array<{ type: string; resource?: { mimeType?: string } }>;
    };
    expect(view.content[0]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf" } });
  });

  it("returns tool errors as isError results", async () => {
    const res = await client.callTool({ name: "pdf_info", arguments: { path: "nope.pdf" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("File not found");
  });
});
