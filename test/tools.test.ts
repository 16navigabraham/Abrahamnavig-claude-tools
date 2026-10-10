import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf, imagePaths, parseBlocks, pdfCreate, pdfInfo, pdfMerge, pdfRead, pdfView } from "../src/tools/pdf.js";
import { uploadFile } from "../src/tools/files.js";
import type { ToolContext } from "../src/tools/types.js";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { workspace: await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-")) };
});
afterEach(async () => {
  await fs.rm(ctx.workspace, { recursive: true, force: true });
});

const create = (p: string, content: string, extra: Record<string, unknown> = {}) =>
  pdfCreate.run(pdfCreate.inputSchema.parse({ path: p, content, ...extra }), ctx);

// A real, minimal valid 1x1 red PNG — not a fake/stubbed byte string, so pdf-lib's
// actual embedPng() runs for real in these tests.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("parseBlocks", () => {
  it("parses headings, bullets and paragraphs, preserving line breaks within a paragraph", () => {
    expect(parseBlocks("# Title\nline one\nline two\n\n- a\n- b\n## Sub")).toEqual([
      { kind: "h1", text: "Title" },
      { kind: "p", lines: ["line one", "line two"] },
      { kind: "li", text: "a" },
      { kind: "li", text: "b" },
      { kind: "h2", text: "Sub" },
    ]);
  });

  it("starts a new paragraph only on a blank line", () => {
    expect(parseBlocks("a\nb\n\nc")).toEqual([
      { kind: "p", lines: ["a", "b"] },
      { kind: "p", lines: ["c"] },
    ]);
  });
});

describe("pdf tools", () => {
  it("creates a PDF that can be read back", async () => {
    const [res] = await create("out/hello.pdf", "# Intro\nHello from Claude\n\n- first point", {
      title: "Report",
      author: "Abraham",
    });
    expect(res).toMatchObject({ type: "text" });

    const [text] = await pdfRead.run(pdfRead.inputSchema.parse({ path: "out/hello.pdf" }), ctx);
    expect(text.type === "text" && text.text).toContain("Hello from Claude");

    const [info] = await pdfInfo.run({ path: "out/hello.pdf" }, ctx);
    const parsed = JSON.parse(info.type === "text" ? info.text : "{}");
    expect(parsed).toMatchObject({ pages: 1, title: "Report", author: "Abraham" });
  });

  it("paginates long content and replaces unsupported characters", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(20)}\n`).join("\n");
    await create("long.pdf", `${long}\nNaira ₦ and emoji 🚀`);
    const [info] = await pdfInfo.run({ path: "long.pdf" }, ctx);
    expect(JSON.parse(info.type === "text" ? info.text : "{}").pages).toBeGreaterThan(5);
  });

  it("reports how many characters couldn't be rendered, silently for none", async () => {
    const [clean] = await create("clean.pdf", "Plain ASCII only.");
    expect(clean.type === "text" && clean.text).not.toContain("could not");

    // ₦ and 🚀 fall outside WinAnsi -> 2 substitutions.
    const [warned] = await create("unicode.pdf", "Naira ₦ and emoji 🚀");
    expect(warned.type === "text" && warned.text).toContain("2 character(s)");
  });

  it("buildPdf counts substitutions directly", async () => {
    const clean = await buildPdf({ content: "hello world", pageSize: "A4" });
    expect(clean.unsupportedChars).toBe(0);

    const unicode = await buildPdf({ content: "₦₦₦", pageSize: "A4" });
    expect(unicode.unsupportedChars).toBe(3);
  });

  it("refuses to overwrite unless asked", async () => {
    await create("a.pdf", "one");
    await expect(create("a.pdf", "two")).rejects.toThrow(/already exists/);
    await expect(create("a.pdf", "two", { overwrite: true })).resolves.toBeDefined();
  });

  it("rejects paths outside the workspace", async () => {
    await expect(create("../escape.pdf", "x")).rejects.toThrow(/outside the workspace/);
    await expect(pdfInfo.run({ path: "/etc/passwd.pdf" }, ctx)).rejects.toThrow(/outside the workspace/);
  });

  it("rejects a symlink inside the workspace that points outside it", async () => {
    // A lexical path.resolve() check alone would pass here — the symlink's own
    // NAME is inside the workspace — but every fs call that follows it lands
    // outside. resolveInWorkspace must catch this via realpath, not just string
    // comparison. Regression test for a Copilot-flagged finding on PR #1.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-outside-"));
    await fs.writeFile(path.join(outside, "secret.pdf"), "%PDF-1.4\nnot yours");
    const link = path.join(ctx.workspace, "escape-link");
    await fs.symlink(outside, link, "dir");
    try {
      await expect(pdfInfo.run({ path: "escape-link/secret.pdf" }, ctx)).rejects.toThrow(/outside the workspace/);
      // Also block writing THROUGH a symlink, not just reading through one.
      await expect(create("escape-link/pwned.pdf", "x")).rejects.toThrow(/outside the workspace/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("reads a page range and reports missing files", async () => {
    await create("r.pdf", "text");
    await expect(pdfRead.run(pdfRead.inputSchema.parse({ path: "r.pdf", start_page: 3 }), ctx)).rejects.toThrow(/past the end/);
    await expect(pdfRead.run(pdfRead.inputSchema.parse({ path: "missing.pdf" }), ctx)).rejects.toThrow(/not found/);
  });

  it("returns the PDF bytes for viewing", async () => {
    await create("v.pdf", "view me");
    const [res] = await pdfView.run({ path: "v.pdf" }, ctx);
    expect(res.type).toBe("pdf");
    if (res.type === "pdf") expect(Buffer.from(res.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("merges PDFs in order", async () => {
    await create("m1.pdf", "first");
    await create("m2.pdf", "second");
    await pdfMerge.run(pdfMerge.inputSchema.parse({ inputs: ["m1.pdf", "m2.pdf"], output: "merged.pdf" }), ctx);
    const [text] = await pdfRead.run(pdfRead.inputSchema.parse({ path: "merged.pdf" }), ctx);
    const body = text.type === "text" ? text.text : "";
    expect(body).toContain("pages 1-2 of 2");
    expect(body.indexOf("first")).toBeLessThan(body.indexOf("second"));
  });
});

describe("upload_file", () => {
  const upload = (p: string, data: string, extra: Record<string, unknown> = {}) =>
    uploadFile.run(uploadFile.inputSchema.parse({ path: p, data, ...extra }), ctx);

  it("decodes base64 and writes the file into the workspace", async () => {
    const [res] = await upload("assets/logo.png", TINY_PNG_BASE64);
    expect(res.type === "text" && res.text).toContain("Uploaded assets/logo.png");
    const bytes = await fs.readFile(path.join(ctx.workspace, "assets/logo.png"));
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  });

  it("rejects invalid base64 and empty decoded content", async () => {
    await expect(upload("x.bin", "not valid base64 !!! ###")).rejects.toThrow();
    await expect(upload("empty.bin", "")).rejects.toThrow(/empty/);
  });

  it("refuses to overwrite unless asked, same as the PDF write tools", async () => {
    await upload("a.png", TINY_PNG_BASE64);
    await expect(upload("a.png", TINY_PNG_BASE64)).rejects.toThrow(/already exists/);
    await expect(upload("a.png", TINY_PNG_BASE64, { overwrite: true })).resolves.toBeDefined();
  });
});

describe("images in pdf_create", () => {
  it("extracts image paths from markdown image lines only", () => {
    expect(imagePaths("# Title\n![Logo](assets/logo.png)\nNot ![an image reference inline\n\n![Chart](out/chart.png)")).toEqual([
      "assets/logo.png",
      "out/chart.png",
    ]);
  });

  it("embeds a real uploaded PNG into the generated PDF", async () => {
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "assets/logo.png", data: TINY_PNG_BASE64 }), ctx);
    const [res] = await create("with-image.pdf", "# Report\n\n![Our logo](assets/logo.png)\n\nBody text after the image.");
    const text = res.type === "text" ? res.text : "";
    expect(text).not.toContain("image not found");
    expect(text).toContain("Created with-image.pdf");

    const [info] = await pdfInfo.run({ path: "with-image.pdf" }, ctx);
    expect(JSON.parse(info.type === "text" ? info.text : "{}").pages).toBe(1);
  });

  it("fails clearly, before writing anything, when the referenced image doesn't exist", async () => {
    await expect(create("broken.pdf", "![Missing](nope.png)")).rejects.toThrow(/File not found: nope\.png/);
  });

  it("buildPdf itself reports a missing image inline rather than throwing", async () => {
    const { bytes } = await buildPdf({ content: "![Missing](nope.png)", pageSize: "A4" });
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });
});
