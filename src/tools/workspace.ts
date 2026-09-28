import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolError, type ToolContext } from "./types.js";

export function defaultWorkspace(): string {
  return path.resolve(process.env.CLAUDE_TOOLS_WORKSPACE ?? "workspace");
}

function containedIn(root: string, full: string): boolean {
  return full === root || full.startsWith(root + path.sep);
}

/**
 * Resolve a user-supplied path inside the workspace, rejecting anything that escapes it —
 * including via a symlink. A lexical check alone (path.resolve + prefix compare) isn't enough:
 * every fs call that follows still resolves symlinks on disk, so a symlink planted inside the
 * workspace (e.g. `evil -> /etc`) would pass the lexical check but let reads/writes reach outside
 * it. We resolve the real path of the nearest existing ancestor and re-run the containment check
 * against that, then require every remaining (not-yet-created) path segment to be a plain name,
 * not a symlink, so a write can't be redirected out either.
 */
export function resolveInWorkspace(ctx: ToolContext, relPath: string): string {
  const root = path.resolve(ctx.workspace);
  const full = path.resolve(root, relPath);
  if (!containedIn(root, full)) {
    throw new ToolError(`Path "${relPath}" is outside the workspace`);
  }

  // Walk down from the root, resolving symlinks as we go, until we hit a path
  // segment that doesn't exist yet (fine — that's what write tools create). The
  // root itself may be a symlink (e.g. CLAUDE_TOOLS_WORKSPACE pointing at a
  // mounted volume) — that's fine, its real location becomes the boundary. On
  // a brand-new box the root may not exist yet (nothing has been written); in
  // that case there's nothing on disk that could be a symlink, so fall back to
  // the lexical root itself.
  let boundary: string;
  try {
    boundary = fsSync.realpathSync(root);
  } catch {
    boundary = root;
  }
  const relFromRoot = path.relative(root, full);
  const segments = relFromRoot === "" ? [] : relFromRoot.split(path.sep);

  let resolved = boundary;
  for (const segment of segments) {
    const next = path.join(resolved, segment);
    let real: string;
    try {
      real = fsSync.realpathSync(next);
    } catch {
      // Doesn't exist yet — nothing to resolve, and nothing left can be a symlink either.
      resolved = next;
      continue;
    }
    if (!containedIn(boundary, real)) {
      throw new ToolError(`Path "${relPath}" is outside the workspace`);
    }
    resolved = real;
  }
  return resolved;
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
