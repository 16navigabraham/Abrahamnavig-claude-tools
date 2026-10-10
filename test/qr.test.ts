import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qrCreate } from "../src/tools/qr.js";
import type { ToolContext } from "../src/tools/types.js";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { workspace: await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-qr-")) };
});
afterEach(async () => {
  await fs.rm(ctx.workspace, { recursive: true, force: true });
});

describe("qr_create", () => {
  it("writes a real, decodable-shaped PNG at the requested size", async () => {
    const [res] = await qrCreate.run(
      qrCreate.inputSchema.parse({ path: "invite.png", data: "https://example.com/invite/abc", size: 300 }),
      ctx,
    );
    expect(res.type === "text" && res.text).toContain("300x300");

    const out = await fs.readFile(path.join(ctx.workspace, "invite.png"));
    expect(out.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(300);
  });

  it("defaults to a 512px QR and refuses to overwrite without the flag", async () => {
    await qrCreate.run(qrCreate.inputSchema.parse({ path: "a.png", data: "hello" }), ctx);
    const out = await fs.readFile(path.join(ctx.workspace, "a.png"));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(512);

    await expect(qrCreate.run(qrCreate.inputSchema.parse({ path: "a.png", data: "hello again" }), ctx)).rejects.toThrow(
      /already exists/,
    );
  });
});
