import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageEdit } from "../src/tools/image.js";
import { uploadFile } from "../src/tools/files.js";
import type { ToolContext } from "../src/tools/types.js";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { workspace: await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-img-")) };
});
afterEach(async () => {
  await fs.rm(ctx.workspace, { recursive: true, force: true });
});

/** A real 40x30 PNG, generated fresh each time (not a hardcoded stub). */
async function seedPng(relPath: string): Promise<Buffer> {
  const png = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
  await uploadFile.run(uploadFile.inputSchema.parse({ path: relPath, data: png.toString("base64") }), ctx);
  return png;
}

const edit = (overrides: Record<string, unknown>) => imageEdit.run(imageEdit.inputSchema.parse({ path: "src.png", ...overrides }), ctx);

describe("image_edit", () => {
  it("resizes, shrinking only, preserving aspect ratio", async () => {
    await seedPng("src.png");
    const [res] = await edit({ output: "small.png", width: 20 });
    expect(res.type === "text" && res.text).toContain("40x30");

    const out = await fs.readFile(path.join(ctx.workspace, "small.png"));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(15); // aspect ratio preserved (40:30 -> 20:15)
  });

  it("never enlarges past the source size", async () => {
    await seedPng("src.png");
    await edit({ output: "big.png", width: 400 });
    const out = await fs.readFile(path.join(ctx.workspace, "big.png"));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeLessThanOrEqual(40);
  });

  it("converts PNG to JPEG with a quality setting", async () => {
    await seedPng("src.png");
    const [res] = await edit({ output: "out.jpg", format: "jpeg", quality: 40 });
    expect(res.type === "text" && res.text).toContain("jpeg");
    const out = await fs.readFile(path.join(ctx.workspace, "out.jpg"));
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic
  });

  it("edits in place (no output given) without needing overwrite:true", async () => {
    const original = await seedPng("src.png");
    await edit({ width: 20 }); // no output, no overwrite flag
    const out = await fs.readFile(path.join(ctx.workspace, "src.png"));
    expect(out.length).not.toBe(original.length);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(20);
  });

  it("still requires overwrite:true for a NEW path that already exists", async () => {
    await seedPng("src.png");
    await seedPng("taken.png");
    await expect(edit({ output: "taken.png" })).rejects.toThrow(/already exists/);
    await expect(edit({ output: "taken.png", overwrite: true })).resolves.toBeDefined();
  });

  it("rejects a file that isn't a readable image", async () => {
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "notimage.png", data: Buffer.from("plain text").toString("base64") }), ctx);
    await expect(imageEdit.run(imageEdit.inputSchema.parse({ path: "notimage.png", output: "x.png" }), ctx)).rejects.toThrow();
  });
});
