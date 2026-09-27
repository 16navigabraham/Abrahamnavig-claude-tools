#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultWorkspace } from "../tools/index.js";
import { createServer } from "./server.js";

const workspace = defaultWorkspace();
await createServer({ workspace }).connect(new StdioServerTransport());
// stdout carries the protocol, so log to stderr.
console.error(`claude-tools MCP server running on stdio (workspace: ${workspace})`);
