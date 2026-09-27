import fs from "node:fs/promises";
import path from "node:path";
import { ToolError, type ToolContext } from "./types.js";

export function defaultWorkspace(): string {
  return path.resolve(process.env.CLAUDE_TOOLS_WORKSPACE ?? "workspace");
}

/** Resolve a user-supplied path inside the workspace, rejecting anything that escapes it. */
export function resolveInWorkspace(ctx: ToolContext, relPath: string): string {
  const root = path.resolve(ctx.workspace);
  const full = path.resolve(root, relPath);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new ToolError(`Path "${relPath}" is outside the workspace`);
  }
  return full;
}

export async function readWorkspaceFile(ctx: ToolContext, relPath: string): Promise<Uint8Array> {
  const full = resolveInWorkspace(ctx, relPath);
  try {
    return new Uint8Array(await fs.readFile(full));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError(`File not found: ${relPath}`);
    }
    throw err;
  }
}

/** Write a file into the workspace. Refuses to replace an existing file unless `overwrite` is set. */
export async function writeWorkspaceFile(
  ctx: ToolContext,
  relPath: string,
  data: Uint8Array,
  overwrite: boolean,
): Promise<string> {
  const full = resolveInWorkspace(ctx, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  try {
    await fs.writeFile(full, data, { flag: overwrite ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ToolError(`${relPath} already exists. Pass overwrite: true to replace it.`);
    }
    throw err;
  }
  return path.relative(ctx.workspace, full);
}
