import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { z } from "zod";
import { defineTool, ToolError } from "./types.js";
import { linkLine } from "./files.js";
import { readWorkspaceFile, writeWorkspaceFile } from "./workspace.js";

// Claude's document input accepts PDFs up to 32 MB per request.
const MAX_VIEW_BYTES = 32 * 1024 * 1024;

const pdfPath = z
  .string()
  .min(1)
  .regex(/\.pdf$/i, "Path must end in .pdf")
  .describe("Path relative to the tools workspace, e.g. reports/q3.pdf");

// ---------------------------------------------------------------------------
// Layout for pdf_create

const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] } as const;
const MARGIN = 56;

type Block =
  | { kind: "h1" | "h2" | "p"; text: string }
  | { kind: "li"; text: string };

/** Parse a small Markdown subset: `#`/`##` headings, `-`/`*` bullets, blank-line paragraphs. */
export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of content.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push({ kind: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("# ")) {
      flush();
      blocks.push({ kind: "h1", text: line.slice(2).trim() });
    } else if (/^[-*] /.test(line)) {
      flush();
      blocks.push({ kind: "li", text: line.slice(2).trim() });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** The standard PDF fonts only cover WinAnsi; swap anything else for "?" instead of failing. */
function encodable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildPdf(opts: {
  title?: string;
  author?: string;
  content: string;
  pageSize: keyof typeof PAGE_SIZES;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [pageW, pageH] = PAGE_SIZES[opts.pageSize];
  const textW = pageW - MARGIN * 2;

  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  doc.setProducer("abrahamnavig-claude-tools");

  let page: PDFPage = doc.addPage([pageW, pageH]);
  let y = pageH - MARGIN;

  const draw = (text: string, font: PDFFont, size: number, indent = 0, gapAfter = 6) => {
    const lineH = size * 1.35;
    for (const line of wrap(font, size, encodable(font, text), textW - indent)) {
      if (y - lineH < MARGIN) {
        page = doc.addPage([pageW, pageH]);
        y = pageH - MARGIN;
      }
      y -= lineH;
      page.drawText(line, { x: MARGIN + indent, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= gapAfter;
  };

  if (opts.title) draw(opts.title, bold, 22, 0, 14);
  for (const block of parseBlocks(opts.content)) {
    if (block.kind === "h1") draw(block.text, bold, 17, 0, 8);
    else if (block.kind === "h2") draw(block.text, bold, 14, 0, 6);
    else if (block.kind === "li") draw(`• ${block.text}`, regular, 11, 12, 3);
    else draw(block.text, regular, 11, 0, 8);
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Tools

export const pdfCreate = defineTool({
  name: "pdf_create",
  title: "Create PDF",
  kind: "write",
  description:
    "Create a new PDF from text. `content` supports a small Markdown subset: lines starting with " +
    "'# ' or '## ' are headings, '- ' are bullets, and blank lines separate paragraphs. Only " +
    "Latin characters render; others are replaced with '?'. Fails if the file exists unless overwrite is true.",
  inputSchema: z.object({
    path: pdfPath,
    title: z.string().optional().describe("Shown as the first heading and stored as document metadata"),
    author: z.string().optional(),
    content: z.string().describe("Body text in the Markdown subset described above"),
    page_size: z.enum(["A4", "Letter"]).default("A4"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const bytes = await buildPdf({
      title: input.title,
      author: input.author,
      content: input.content,
      pageSize: input.page_size,
    });
    const saved = await writeWorkspaceFile(ctx, input.path, bytes, input.overwrite);
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    return [
      { type: "text", text: `Created ${saved} (${pages} page(s), ${bytes.byteLength} bytes)` },
      ...linkLine(ctx, saved),
    ];
  },
});

export const pdfRead = defineTool({
  name: "pdf_read",
  title: "Read PDF text",
  kind: "read",
  description:
    "Extract the text of a PDF, page by page. Use for searching or quoting text. Scanned PDFs " +
    "without a text layer return little or nothing; use pdf_view for those.",
  inputSchema: z.object({
    path: pdfPath,
    start_page: z.number().int().min(1).default(1),
    end_page: z.number().int().min(1).optional().describe("Inclusive. Defaults to the last page"),
  }),
  async run(input, ctx) {
    const data = await readWorkspaceFile(ctx, input.path);
    const { totalPages, text } = await extractText(await getDocumentProxy(data), { mergePages: false });
    const end = Math.min(input.end_page ?? totalPages, totalPages);
    if (input.start_page > end) {
      throw new ToolError(`start_page ${input.start_page} is past the end (${totalPages} pages)`);
    }
    const parts = [`${input.path}: pages ${input.start_page}-${end} of ${totalPages}`];
    for (let i = input.start_page; i <= end; i++) {
      parts.push(`--- Page ${i} ---\n${text[i - 1]?.trim() || "(no text layer)"}`);
    }
    return [{ type: "text", text: parts.join("\n\n") }];
  },
});

export const pdfInfo = defineTool({
  name: "pdf_info",
  title: "PDF info",
  kind: "read",
  description: "Get a PDF's page count, page size, file size and metadata (title, author, dates).",
  inputSchema: z.object({ path: pdfPath }),
  async run(input, ctx) {
    const data = await readWorkspaceFile(ctx, input.path);
    const size = data.byteLength;
    const proxy = await getDocumentProxy(data);
    const { info } = await getMeta(proxy);
    const first = await proxy.getPage(1);
    const [, , w, h] = first.view;
    const summary = {
      path: input.path,
      pages: proxy.numPages,
      bytes: size,
      first_page_size_pt: { width: Math.round(w), height: Math.round(h) },
      title: info.Title ?? null,
      author: info.Author ?? null,
      creator: info.Creator ?? null,
      producer: info.Producer ?? null,
      created: info.CreationDate ?? null,
      modified: info.ModDate ?? null,
    };
    return [{ type: "text", text: JSON.stringify(summary, null, 2) }];
  },
});

export const pdfView = defineTool({
  name: "pdf_view",
  title: "View PDF",
  kind: "read",
  description:
    "Return the PDF itself so you can see its layout, tables, charts and scanned pages, not just " +
    "the text layer. Prefer pdf_read for plain text; this costs more tokens.",
  inputSchema: z.object({ path: pdfPath }),
  async run(input, ctx) {
    const data = await readWorkspaceFile(ctx, input.path);
    if (data.byteLength > MAX_VIEW_BYTES) {
      throw new ToolError(`${input.path} is ${data.byteLength} bytes; the limit for viewing is 32 MB`);
    }
    return [{ type: "pdf", base64: Buffer.from(data).toString("base64"), title: input.path }];
  },
});

export const pdfMerge = defineTool({
  name: "pdf_merge",
  title: "Merge PDFs",
  kind: "write",
  description: "Combine several PDFs, in the given order, into one new PDF.",
  inputSchema: z.object({
    inputs: z.array(pdfPath).min(2),
    output: pdfPath,
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const merged = await PDFDocument.create();
    for (const rel of input.inputs) {
      const src = await PDFDocument.load(await readWorkspaceFile(ctx, rel));
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    const bytes = await merged.save();
    const saved = await writeWorkspaceFile(ctx, input.output, bytes, input.overwrite);
    return [
      { type: "text", text: `Merged ${input.inputs.length} files into ${saved} (${merged.getPageCount()} pages)` },
      ...linkLine(ctx, saved),
    ];
  },
});

export const pdfTools = [pdfCreate, pdfRead, pdfInfo, pdfView, pdfMerge];
