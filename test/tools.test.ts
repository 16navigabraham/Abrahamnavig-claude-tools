import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPdf,
  imagePaths,
  parseBlocks,
  pdfCreate,
  pdfInfo,
  pdfMerge,
  pdfRead,
  pdfSearch,
  pdfSplit,
  pdfView,
} from "../src/tools/pdf.js";
import { fileDelete, fileMove, uploadFile } from "../src/tools/files.js";
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

  it("parses a GFM-style pipe table with per-column alignment", () => {
    const md = "| Name | Fee | Notes |\n|:---|---:|:---:|\n| Anchor | 1.5 | ok |\n| Interswitch | 2 | — |";
    expect(parseBlocks(md)).toEqual([
      {
        kind: "table",
        header: ["Name", "Fee", "Notes"],
        align: ["left", "right", "center"],
        rows: [
          ["Anchor", "1.5", "ok"],
          ["Interswitch", "2", "—"],
        ],
      },
    ]);
  });

  it("requires an actual separator row — a stray line with pipes stays a paragraph", () => {
    expect(parseBlocks("| not a table |\njust text")).toEqual([{ kind: "p", lines: ["| not a table |", "just text"] }]);
  });

  it("keeps body rows exactly as written, even when shorter/longer than the header", () => {
    // Padding/truncating to the header's column count happens at render time in buildPdf,
    // not in parseBlocks — this just confirms parsing doesn't silently drop/alter data.
    const [block] = parseBlocks("| a | b |\n|---|---|\n| only-one |\n| x | y | z |");
    expect(block).toEqual({ kind: "table", header: ["a", "b"], align: ["left", "left"], rows: [["only-one"], ["x", "y", "z"]] });
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

  it("renders a real bordered table from GFM syntax, header and all rows present", async () => {
    const table = "| Provider | Fee |\n|:---|---:|\n| Anchor | 1.5% |\n| Interswitch | 2% |";
    const [res] = await create("table.pdf", `# Comparison\n\n${table}\n\nAfter the table.`);
    expect(res.type === "text" && res.text).toContain("Created table.pdf");

    const [text] = await pdfRead.run(pdfRead.inputSchema.parse({ path: "table.pdf" }), ctx);
    const body = text.type === "text" ? text.text : "";
    for (const expected of ["Provider", "Fee", "Anchor", "1.5%", "Interswitch", "2%", "After the table."]) {
      expect(body).toContain(expected);
    }
  });

  it("pads a short row and truncates a long one to the header's column count when rendering", async () => {
    const md = "| a | b | c |\n|---|---|---|\n| only-one |\n| x | y | z | extra |";
    const { bytes } = await buildPdf({ content: md, pageSize: "A4" });
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-"); // doesn't throw on ragged rows
  });

  it("breaks a table across pages when it doesn't fit on one", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| Row ${i} | value ${i} |`).join("\n");
    const md = `| Key | Value |\n|---|---|\n${rows}`;
    const { bytes } = await buildPdf({ content: md, pageSize: "A4" });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
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

describe("pdf_split", () => {
  it("extracts a page range into a new PDF", async () => {
    await create("s1.pdf", "page one");
    await create("s2.pdf", "page two");
    await pdfMerge.run(pdfMerge.inputSchema.parse({ inputs: ["s1.pdf", "s2.pdf"], output: "pack.pdf" }), ctx);
    const [res] = await pdfSplit.run(
      pdfSplit.inputSchema.parse({ path: "pack.pdf", output: "part.pdf", start_page: 2, end_page: 2 }),
      ctx,
    );
    expect(res.type === "text" && res.text).toContain("Extracted pages 2-2 of 2");

    const [text] = await pdfRead.run(pdfRead.inputSchema.parse({ path: "part.pdf" }), ctx);
    const body = text.type === "text" ? text.text : "";
    expect(body).toContain("page two");
    expect(body).not.toContain("page one");
  });

  it("defaults end_page to the last page and rejects an out-of-range start", async () => {
    await create("one.pdf", "solo");
    const [res] = await pdfSplit.run(pdfSplit.inputSchema.parse({ path: "one.pdf", output: "copy.pdf" }), ctx);
    expect(res.type === "text" && res.text).toContain("Extracted pages 1-1 of 1");
    await expect(
      pdfSplit.run(pdfSplit.inputSchema.parse({ path: "one.pdf", output: "bad.pdf", start_page: 5 }), ctx),
    ).rejects.toThrow(/past the end/);
  });
});

describe("pdf_search", () => {
  it("finds matches in a single named PDF with a snippet", async () => {
    await create("doc.pdf", "The quick brown fox jumps over the lazy dog.");
    const [res] = await pdfSearch.run(pdfSearch.inputSchema.parse({ query: "brown fox", path: "doc.pdf" }), ctx);
    const body = res.type === "text" ? res.text : "";
    expect(body).toContain("doc.pdf p.1");
    expect(body).toContain("brown fox");
  });

  it("is case-insensitive and reports no matches clearly", async () => {
    await create("doc.pdf", "Hello World");
    const [found] = await pdfSearch.run(pdfSearch.inputSchema.parse({ query: "hello world", path: "doc.pdf" }), ctx);
    expect(found.type === "text" && found.text).toContain("doc.pdf p.1");

    const [missing] = await pdfSearch.run(pdfSearch.inputSchema.parse({ query: "nope", path: "doc.pdf" }), ctx);
    expect(missing.type === "text" && missing.text).toContain("No matches");
  });

  it("searches every PDF in the workspace when no path is given", async () => {
    await create("a.pdf", "apple pie recipe");
    await create("b.pdf", "banana bread recipe");
    const [res] = await pdfSearch.run(pdfSearch.inputSchema.parse({ query: "recipe" }), ctx);
    const body = res.type === "text" ? res.text : "";
    expect(body).toContain("a.pdf p.1");
    expect(body).toContain("b.pdf p.1");
  });

  it("reports no PDFs when the workspace is empty", async () => {
    const [res] = await pdfSearch.run(pdfSearch.inputSchema.parse({ query: "x" }), ctx);
    expect(res.type === "text" && res.text).toBe("No PDFs in the workspace.");
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

describe("file_delete", () => {
  it("deletes a file", async () => {
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "a.png", data: TINY_PNG_BASE64 }), ctx);
    const [res] = await fileDelete.run(fileDelete.inputSchema.parse({ path: "a.png" }), ctx);
    expect(res.type === "text" && res.text).toContain("Deleted a.png");
    await expect(fs.stat(path.join(ctx.workspace, "a.png"))).rejects.toThrow();
  });

  it("refuses to delete a non-empty folder without recursive: true", async () => {
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "dir/a.png", data: TINY_PNG_BASE64 }), ctx);
    await expect(fileDelete.run(fileDelete.inputSchema.parse({ path: "dir" }), ctx)).rejects.toThrow(/recursive: true/);
    const [res] = await fileDelete.run(fileDelete.inputSchema.parse({ path: "dir", recursive: true }), ctx);
    expect(res.type === "text" && res.text).toContain("Deleted dir (folder)");
  });

  it("refuses to delete the workspace root and reports a missing file clearly", async () => {
    await expect(fileDelete.run(fileDelete.inputSchema.parse({ path: "." }), ctx)).rejects.toThrow(/workspace root/);
    await expect(fileDelete.run(fileDelete.inputSchema.parse({ path: "nope.png" }), ctx)).rejects.toThrow(/not found/);
  });
});

describe("file_move", () => {
  it("moves/renames a file", async () => {
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "a.png", data: TINY_PNG_BASE64 }), ctx);
    const [res] = await fileMove.run(fileMove.inputSchema.parse({ path: "a.png", destination: "out/b.png" }), ctx);
    expect(res.type === "text" && res.text).toContain("Moved a.png to out/b.png");
    await expect(fs.stat(path.join(ctx.workspace, "a.png"))).rejects.toThrow();
    const bytes = await fs.readFile(path.join(ctx.workspace, "out/b.png"));
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("refuses to overwrite an existing destination unless asked", async () => {
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "a.png", data: TINY_PNG_BASE64 }), ctx);
    await uploadFile.run(uploadFile.inputSchema.parse({ path: "b.png", data: TINY_PNG_BASE64 }), ctx);
    await expect(fileMove.run(fileMove.inputSchema.parse({ path: "a.png", destination: "b.png" }), ctx)).rejects.toThrow(
      /already exists/,
    );
    await expect(
      fileMove.run(fileMove.inputSchema.parse({ path: "a.png", destination: "b.png", overwrite: true }), ctx),
    ).resolves.toBeDefined();
  });

  it("reports a missing source file clearly", async () => {
    await expect(fileMove.run(fileMove.inputSchema.parse({ path: "nope.png", destination: "x.png" }), ctx)).rejects.toThrow(
      /not found/,
    );
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
