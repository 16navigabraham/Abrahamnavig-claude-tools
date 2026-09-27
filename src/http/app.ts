import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createServer } from "../mcp/server.js";
import type { ToolContext } from "../tools/index.js";
import { resolveInWorkspace } from "../tools/workspace.js";

export interface HttpConfig {
  workspace: string;
  /** Secret clients must present, as `Authorization: Bearer <token>` or in the URL path `/mcp/<token>`. */
  authToken: string;
  /** Public base URL, e.g. https://tools.example.com. Used to build download links. */
  publicUrl: string;
  /** Download link lifetime in seconds. */
  linkTtlSeconds: number;
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Signs and verifies time-limited download links. The key is derived from the auth token. */
export function linkSigner(config: HttpConfig) {
  const key = crypto.createHmac("sha256", config.authToken).update("file-links-v1").digest();
  const sign = (relPath: string, exp: number) =>
    crypto.createHmac("sha256", key).update(`${relPath}\n${exp}`).digest("base64url");

  return {
    url(relPath: string, now = Date.now()): string {
      const exp = Math.floor(now / 1000) + config.linkTtlSeconds;
      const encoded = relPath.split(path.sep).map(encodeURIComponent).join("/");
      return `${config.publicUrl.replace(/\/$/, "")}/files/${encoded}?exp=${exp}&sig=${sign(relPath, exp)}`;
    },
    verify(relPath: string, exp: number, sig: string, now = Date.now()): boolean {
      if (!Number.isFinite(exp) || exp < now / 1000) return false;
      return sameSecret(sign(relPath, exp), sig);
    },
  };
}

export function createApp(config: HttpConfig) {
  const links = linkSigner(config);
  const ctx: ToolContext = { workspace: config.workspace, fileUrl: (p) => links.url(p) };

  const app = express();
  app.disable("x-powered-by");
  // Behind Caddy, so trust the first proxy for client IPs (rate limiting).
  app.set("trust proxy", 1);

  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // --- MCP (Streamable HTTP, stateless: one server per request) ---

  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const pathToken = typeof req.params.token === "string" ? req.params.token : "";
    if ((bearer && sameSecret(bearer, config.authToken)) || (pathToken && sameSecret(pathToken, config.authToken))) {
      return next();
    }
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  const handleMcp = async (req: Request, res: Response) => {
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." },
      id: null,
    });
  };

  for (const route of ["/mcp", "/mcp/:token"]) {
    app.post(route, limiter, requireToken, express.json({ limit: "4mb" }), handleMcp);
    app.get(route, limiter, requireToken, notAllowed);
    app.delete(route, limiter, requireToken, notAllowed);
  }

  // --- Signed download links ---

  app.get("/files/*filePath", limiter, (req, res) => {
    const parts = (req.params as { filePath: string[] }).filePath;
    const relPath = parts.join(path.sep);
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!links.verify(relPath, exp, sig)) {
      res.status(403).send("This link is invalid or has expired.");
      return;
    }
    let full: string;
    try {
      full = resolveInWorkspace(ctx, relPath);
    } catch {
      res.status(403).send("Forbidden");
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).send("Not found");
      return;
    }
    res.download(full, path.basename(full));
  });

  return app;
}
