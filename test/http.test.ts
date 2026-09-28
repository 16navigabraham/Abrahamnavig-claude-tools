import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, linkSigner } from "../src/http/app.js";
import { isPrivateAddress, pdfImportUrl } from "../src/tools/files.js";

const TOKEN = "t".repeat(40);
let workspace: string;
let server: Server;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-http-"));
  // The port is only known after listen, so the app (which needs publicUrl) is built then.
  const config = { workspace, authToken: TOKEN, publicUrl: "", linkTtlSeconds: 60 };
  await new Promise<void>((resolve) => {
    const holder: { app?: ReturnType<typeof createApp> } = {};
    server = http.createServer((req, res) => holder.app!(req, res));
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      config.publicUrl = base;
      holder.app = createApp(config);
      resolve();
    });
  });
});
afterAll(async () => {
  server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

describe("HTTP server", () => {
  it("answers health checks without auth", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });

  it("rejects MCP requests without the token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect((await fetch(`${base}/mcp/wrong-token`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("serves MCP with a bearer token and returns a working download link", async () => {
    const client = await connect(`${base}/mcp`, { authorization: `Bearer ${TOKEN}` });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["pdf_create", "pdf_import_url", "file_link", "files_list"]));

    const res = await client.callTool({ name: "pdf_create", arguments: { path: "out/r.pdf", content: "online" } });
    const text = JSON.stringify(res.content);
    const url = text.match(/Download: ([^"\\]+)/)?.[1];
    expect(url).toBeDefined();

    const dl = await fetch(url!);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    const tampered = url!.replace("r.pdf", "x.pdf");
    expect((await fetch(tampered)).status).toBe(403);

    const list = await client.callTool({ name: "files_list", arguments: {} });
    expect(JSON.stringify(list.content)).toContain("out/r.pdf");
    await client.close();
  });

  it("accepts the token in the URL path for clients that cannot set headers", async () => {
    const client = await connect(`${base}/mcp/${TOKEN}`);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });
});

describe("download links", () => {
  it("expire", () => {
    const signer = linkSigner({ workspace, authToken: TOKEN, publicUrl: "https://x", linkTtlSeconds: 60 });
    const url = new URL(signer.url("a.pdf", 0));
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig")!;
    expect(signer.verify("a.pdf", exp, sig, 0)).toBe(true);
    expect(signer.verify("a.pdf", exp, sig, 61_000)).toBe(false);
    expect(signer.verify("b.pdf", exp, sig, 0)).toBe(false);
  });
});

describe("pdf_import_url", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "140.238.1.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses to fetch from the server's own network", async () => {
    const run = (url: string) => pdfImportUrl.run(pdfImportUrl.inputSchema.parse({ url, path: "x.pdf" }), { workspace });
    await expect(run(`${base}/health`)).rejects.toThrow(/private address/);
    await expect(run("http://169.254.169.254/opc/v2/instance/")).rejects.toThrow(/private address/);
    await expect(run("http://localhost:1/x.pdf")).rejects.toThrow(/private address/);
    await expect(run("file:///etc/passwd")).rejects.toThrow(/http and https/);
  });
});
