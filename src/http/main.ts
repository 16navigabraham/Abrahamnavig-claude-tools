#!/usr/bin/env node
import { defaultWorkspace } from "../tools/index.js";
import { createApp } from "./app.js";

const authToken = process.env.MCP_AUTH_TOKEN ?? "";
if (authToken.length < 32) {
  console.error("MCP_AUTH_TOKEN must be set to a random string of at least 32 characters (try: openssl rand -hex 32)");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const workspace = defaultWorkspace();

createApp({
  workspace,
  authToken,
  publicUrl,
  linkTtlSeconds: Number(process.env.FILE_LINK_TTL_SECONDS ?? 24 * 60 * 60),
}).listen(port, host, () => {
  console.log(`claude-tools HTTP server on ${host}:${port}`);
  console.log(`MCP endpoint: ${publicUrl}/mcp  (workspace: ${workspace})`);
});
