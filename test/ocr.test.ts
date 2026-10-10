import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/tools/types.js";

// tesseract.js's createWorker downloads language data from a CDN on first use — not
// reachable from CI/sandboxed test runs, and not something to bundle as test fixture
// data (the model is several MB). Mocked here; the real recognize() path was verified
// manually during development (a generated "HELLO WORLD" image OCR'd back correctly
// with real language data). These tests cover ocr_extract's own logic: worker reuse,
// error translation, and result formatting — not tesseract's internals.
const recognize = vi.fn();
const createWorker = vi.fn(async () => ({ recognize }));
vi.mock("tesseract.js", () => ({ createWorker: (...args: unknown[]) => createWorker(...args) }));

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { workspace: await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-ocr-")) };
  await fs.writeFile(path.join(ctx.workspace, "doc.png"), "not a real image, just needs to exist");
  recognize.mockReset();
  createWorker.mockClear();
  // ocr.ts caches its worker in module-level state (that's the point — see its
  // comment on getWorker()), which would otherwise leak across tests via the ESM
  // module cache. Force a fresh module instance per test so each one starts with
  // no worker created yet, keeping createWorker call-count assertions meaningful.
  vi.resetModules();
});
afterEach(async () => {
  await fs.rm(ctx.workspace, { recursive: true, force: true });
});

describe("ocr_extract", () => {
  it("returns extracted text with a rounded confidence score", async () => {
    recognize.mockResolvedValue({ data: { text: "  CAC/IT/12345\nRegistered 2019  ", confidence: 87.6 } });
    const { ocrExtract } = await import("../src/tools/ocr.js");
    const [res] = await ocrExtract.run({ path: "doc.png" }, ctx);
    expect(res.type === "text" && res.text).toBe("doc.png (confidence 88%):\n\nCAC/IT/12345\nRegistered 2019");
  });

  it("reports no text found distinctly, rather than an empty block", async () => {
    recognize.mockResolvedValue({ data: { text: "   ", confidence: 12 } });
    const { ocrExtract } = await import("../src/tools/ocr.js");
    const [res] = await ocrExtract.run({ path: "doc.png" }, ctx);
    expect(res.type === "text" && res.text).toBe("doc.png: no text found (confidence 12%)");
  });

  it("reuses one worker across multiple calls instead of spinning up a new one each time", async () => {
    recognize.mockResolvedValue({ data: { text: "x", confidence: 90 } });
    const { ocrExtract } = await import("../src/tools/ocr.js");
    await ocrExtract.run({ path: "doc.png" }, ctx);
    await ocrExtract.run({ path: "doc.png" }, ctx);
    await ocrExtract.run({ path: "doc.png" }, ctx);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledTimes(3);
  });

  it("fails clearly on a missing workspace file, without touching the OCR engine", async () => {
    const { ocrExtract } = await import("../src/tools/ocr.js");
    await expect(ocrExtract.run({ path: "nope.png" }, ctx)).rejects.toThrow(/File not found/);
    expect(recognize).not.toHaveBeenCalled();
  });

  it("translates a recognize() failure into a clear ToolError", async () => {
    recognize.mockRejectedValue(new Error("corrupt image data"));
    const { ocrExtract } = await import("../src/tools/ocr.js");
    await expect(ocrExtract.run({ path: "doc.png" }, ctx)).rejects.toThrow(/OCR failed on doc\.png.*corrupt image data/);
  });
});
