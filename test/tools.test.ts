import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBlocks, pdfCreate, pdfInfo, pdfMerge, pdfRead, pdfView } from "../src/tools/pdf.js";
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

describe("parseBlocks", () => {
  it("parses headings, bullets and paragraphs", () => {
    expect(parseBlocks("# Title\nline one\nline two\n\n- a\n- b\n## Sub")).toEqual([
      { kind: "h1", text: "Title" },
      { kind: "p", text: "line one line two" },
      { kind: "li", text: "a" },
      { kind: "li", text: "b" },
      { kind: "h2", text: "Sub" },
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
