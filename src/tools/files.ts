import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { defineTool, ToolError, type ToolContent, type ToolContext } from "./types.js";
import { resolveInWorkspace, writeWorkspaceFile } from "./workspace.js";

const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** A "Download: <url>" line when the server has a public URL, otherwise nothing. */
export function linkLine(ctx: ToolContext, relPath: string): ToolContent[] {
  return ctx.fileUrl ? [{ type: "text", text: `Download: ${ctx.fileUrl(relPath)}` }] : [];
}

// ---------------------------------------------------------------------------
// Fetching remote files without reaching the server's private network

/** True for loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return (
    v6 === "::" || v6 === "::1" ||
    v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") ||
    v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff")
  );
}

/** DNS lookup that refuses private addresses. Used as the socket's lookup so the checked IP is the one connected to. */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) {
      return callback(new ToolError(`Refusing to fetch from a private address (${hostname})`), "", 4);
    }
    if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

interface FetchResult {
  data: Uint8Array;
  finalUrl: string;
  status: number;
  contentType: string;
}

async function fetchPublic(url: string, redirects = 0): Promise<FetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ToolError("Only http and https URLs are supported");
  }
  if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new ToolError("Refusing to fetch from a private address");
  }
  const get = parsed.protocol === "https:" ? https.get : http.get;

  return new Promise((resolve, reject) => {
    const req = get(parsed, { lookup: publicLookup, timeout: 30_000, headers: { "user-agent": "abrahamnavig-claude-tools" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new ToolError(`Too many redirects (stopped at ${parsed})`));
        let next: string;
        try {
          next = new URL(res.headers.location, parsed).toString();
        } catch {
          return reject(new ToolError(`${parsed} redirected to an invalid URL: ${res.headers.location}`));
        }
        return resolve(fetchPublic(next, redirects + 1));
      }
      const contentType = (res.headers["content-type"] ?? "unknown").split(";")[0].trim();
      if (status !== 200) {
        res.resume();
        return reject(new ToolError(`Download failed: got HTTP ${status} (${contentType}) from ${parsed}`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMPORT_BYTES) {
          req.destroy();
          reject(new ToolError("File is larger than 32 MB"));
        } else {
          chunks.push(chunk);
        }
      });
      res.on("end", () =>
        resolve({ data: new Uint8Array(Buffer.concat(chunks)), finalUrl: parsed.toString(), status, contentType }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new ToolError("Download timed out")));
    req.on("error", (err) => reject(err instanceof ToolError ? err : new ToolError(`Download failed: ${err.message}`)));
  });
}

// ---------------------------------------------------------------------------
// Tools

export const pdfImportUrl = defineTool({
  name: "pdf_import_url",
  title: "Import PDF from URL",
  kind: "write",
  description:
    "Download a PDF from a public http(s) URL into the workspace so the other PDF tools can use it. " +
    "Up to 32 MB. Fails if the destination exists unless overwrite is true.",
  inputSchema: z.object({
    url: z.string().describe("Public http(s) URL of the PDF"),
    path: z.string().regex(/\.pdf$/i, "Path must end in .pdf").describe("Destination path in the workspace"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const { data, finalUrl, contentType } = await fetchPublic(input.url);
    if (Buffer.from(data.subarray(0, 5)).toString("latin1") !== "%PDF-") {
      const redirectedNote = finalUrl !== input.url ? ` (followed redirect(s) to ${finalUrl})` : "";
      throw new ToolError(
        `The URL did not return a PDF: got HTTP 200 with content-type "${contentType}"${redirectedNote}. ` +
          `This is often a landing page or a client-side redirect rather than a direct PDF link.`,
      );
    }
    const saved = await writeWorkspaceFile(ctx, input.path, data, input.overwrite);
    return [{ type: "text", text: `Imported ${saved} (${data.byteLength} bytes)` }, ...linkLine(ctx, saved)];
  },
});

export const filesList = defineTool({
  name: "files_list",
  title: "List workspace files",
  kind: "read",
  description: "List the files in the workspace (or a folder inside it) with their sizes and modification times.",
  inputSchema: z.object({
    folder: z.string().default(".").describe("Folder relative to the workspace root"),
  }),
  async run(input, ctx) {
    const root = resolveInWorkspace(ctx, input.folder);
    const rows: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const st = await fs.stat(full);
          rows.push(`${path.relative(ctx.workspace, full)}\t${st.size} bytes\t${st.mtime.toISOString()}`);
        }
      }
    };
    await walk(root);
    return [{ type: "text", text: rows.length ? rows.join("\n") : "No files." }];
  },
});

export const uploadFile = defineTool({
  name: "upload_file",
  title: "Upload file",
  kind: "write",
  description:
    "Save any file into the workspace from base64-encoded data and get back a shareable signed " +
    "download link — the general-purpose way to host a file (an image, a logo, a document, " +
    "anything) and hand the user a URL for it. Also how to get an image into the workspace for " +
    "pdf_create: upload it here first, then reference it from pdf_create's content as " +
    "![alt text](path), the same path you upload it to. Up to 32 MB. Fails if the destination " +
    "exists unless overwrite is true.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Destination path in the workspace, e.g. assets/logo.png"),
    data: z.string().describe("Base64-encoded file content"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    // Buffer.from(str, "base64") never throws — it silently skips characters
    // outside the base64 alphabet instead of rejecting the input, so garbage
    // input would otherwise decode "successfully" into garbage bytes. Validate
    // the shape first.
    const stripped = input.data.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
      throw new ToolError("data is not valid base64");
    }
    const bytes = Buffer.from(stripped, "base64");
    if (bytes.length === 0) throw new ToolError("Decoded file is empty — check the base64 data");
    if (bytes.length > MAX_IMPORT_BYTES) throw new ToolError("File is larger than 32 MB");
    const saved = await writeWorkspaceFile(ctx, input.path, bytes, input.overwrite);
    return [{ type: "text", text: `Uploaded ${saved} (${bytes.length} bytes)` }, ...linkLine(ctx, saved)];
  },
});

export const fileDelete = defineTool({
  name: "file_delete",
  title: "Delete file",
  kind: "write",
  description:
    "Delete a file in the workspace — to clean up a test file, a temporary import, or anything " +
    "no longer needed. Pass recursive: true to delete a non-empty folder and everything in it.",
  inputSchema: z.object({
    path: z.string().min(1).describe("File (or folder, with recursive: true) to delete, relative to the workspace"),
    recursive: z.boolean().default(false).describe("Required to delete a folder and its contents"),
  }),
  async run(input, ctx) {
    if (path.normalize(input.path) === ".") {
      throw new ToolError("Refusing to delete the workspace root itself");
    }
    const full = resolveInWorkspace(ctx, input.path);
    const st = await fs.stat(full).catch(() => null);
    if (!st) throw new ToolError(`File not found: ${input.path}`);
    if (st.isDirectory() && !input.recursive) {
      throw new ToolError(`${input.path} is a folder — pass recursive: true to delete it and everything in it`);
    }
    await fs.rm(full, { recursive: input.recursive });
    return [{ type: "text", text: `Deleted ${input.path}${st.isDirectory() ? " (folder)" : ""}` }];
  },
});

export const fileMove = defineTool({
  name: "file_move",
  title: "Move / rename file",
  kind: "write",
  description:
    "Move or rename a file within the workspace. Fails if the destination already exists unless " +
    "overwrite is true.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Existing file, relative to the workspace"),
    destination: z.string().min(1).describe("New path, relative to the workspace"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const src = resolveInWorkspace(ctx, input.path);
    const srcStat = await fs.stat(src).catch(() => null);
    if (!srcStat?.isFile()) throw new ToolError(`File not found: ${input.path}`);

    const dest = resolveInWorkspace(ctx, input.destination);
    if (!input.overwrite) {
      const destExists = await fs.stat(dest).catch(() => null);
      if (destExists) throw new ToolError(`${input.destination} already exists. Pass overwrite: true to replace it.`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(src, dest);
    } catch (err) {
      // EXDEV: source and destination are on different mounted volumes — rename()
      // can't do that atomically, so fall back to copy + delete.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    }
    return [
      { type: "text", text: `Moved ${input.path} to ${input.destination}` },
      ...linkLine(ctx, path.relative(ctx.workspace, dest)),
    ];
  },
});

export const fileLink = defineTool({
  name: "file_link",
  title: "Get download link",
  kind: "read",
  description: "Get a time-limited download link for a file in the workspace, to share with the user.",
  inputSchema: z.object({ path: z.string().describe("File path relative to the workspace") }),
  async run(input, ctx) {
    if (!ctx.fileUrl) throw new ToolError("Download links are only available when the server runs online");
    const full = resolveInWorkspace(ctx, input.path);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) throw new ToolError(`File not found: ${input.path}`);
    return linkLine(ctx, path.relative(ctx.workspace, full));
  },
});

export const fileTools = [pdfImportUrl, uploadFile, fileDelete, fileMove, filesList, fileLink];
