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

type Align = "left" | "center" | "right";

type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "li"; text: string }
  // Standard Markdown image syntax, on its own line: ![alt](workspace-relative-path).
  // The path is looked up in the `images` map passed to buildPdf.
  | { kind: "img"; alt: string; path: string }
  // GFM-style pipe table: a header row, a |---|---| separator (colons set
  // alignment), then zero or more body rows, each starting and ending with |.
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  // A paragraph is its own input lines, not one joined string: a single line
  // break stays a line break (drawn as a forced break), a blank line starts a
  // new paragraph (drawn with the usual gap after).
  | { kind: "p"; lines: string[] };

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const TABLE_ROW = /^\|.+\|$/;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;

/** Every image path referenced in `content`, e.g. to pre-fetch before calling buildPdf. */
export function imagePaths(content: string): string[] {
  const paths = new Set<string>();
  for (const raw of content.replace(/\r\n?/g, "\n").split("\n")) {
    const m = IMAGE_LINE.exec(raw.trim());
    if (m) paths.add(m[2]);
  }
  return [...paths];
}

/** Splits `| a | b |` into `["a", "b"]`. Doesn't handle an escaped `\|` inside a cell. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function tableAlignment(separatorLine: string): Align[] {
  return splitTableRow(separatorLine).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function isTableSeparator(line: string): boolean {
  if (!TABLE_ROW.test(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_SEPARATOR_CELL.test(c));
}

/**
 * Parse a small Markdown subset: `#`/`##` headings, `-`/`*` bullets, `![alt](path)`
 * images, GFM-style pipe tables, blank-line paragraphs.
 */
export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", lines: para });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const imgMatch = IMAGE_LINE.exec(line);
    if (!line) {
      flush();
      i++;
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push({ kind: "h2", text: line.slice(3).trim() });
      i++;
    } else if (line.startsWith("# ")) {
      flush();
      blocks.push({ kind: "h1", text: line.slice(2).trim() });
      i++;
    } else if (/^[-*] /.test(line)) {
      flush();
      blocks.push({ kind: "li", text: line.slice(2).trim() });
      i++;
    } else if (imgMatch) {
      flush();
      blocks.push({ kind: "img", alt: imgMatch[1], path: imgMatch[2] });
      i++;
    } else if (TABLE_ROW.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flush();
      const header = splitTableRow(line);
      const align = tableAlignment(lines[i + 1].trim());
      while (align.length < header.length) align.push("left");
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i].trim())) {
        rows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      blocks.push({ kind: "table", header, align: align.slice(0, header.length), rows });
    } else {
      para.push(line);
      i++;
    }
  }
  flush();
  return blocks;
}

/**
 * The standard PDF fonts only cover WinAnsi; swap anything else for "?" instead of
 * failing, and count the swaps so the caller can tell the user some text didn't render.
 */
function encodable(font: PDFFont, text: string, stats: { replaced: number }): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
      stats.replaced++;
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

function sniffImageFormat(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

export async function buildPdf(opts: {
  title?: string;
  author?: string;
  content: string;
  pageSize: keyof typeof PAGE_SIZES;
  /** Image bytes keyed by the exact path used in `![alt](path)` within content. */
  images?: Record<string, Uint8Array>;
}): Promise<{ bytes: Uint8Array; unsupportedChars: number }> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [pageW, pageH] = PAGE_SIZES[opts.pageSize];
  const textW = pageW - MARGIN * 2;
  const images = opts.images ?? {};

  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  doc.setProducer("abrahamnavig-claude-tools");

  let page: PDFPage = doc.addPage([pageW, pageH]);
  let y = pageH - MARGIN;
  const stats = { replaced: 0 };

  const draw = (text: string, font: PDFFont, size: number, indent = 0, gapAfter = 6) => {
    const lineH = size * 1.35;
    for (const line of wrap(font, size, encodable(font, text, stats), textW - indent)) {
      if (y - lineH < MARGIN) {
        page = doc.addPage([pageW, pageH]);
        y = pageH - MARGIN;
      }
      y -= lineH;
      page.drawText(line, { x: MARGIN + indent, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= gapAfter;
  };

  const drawImage = async (alt: string, path: string) => {
    const bytes = images[path];
    const format = bytes && sniffImageFormat(bytes);
    if (!bytes) return draw(`[image not found: ${path}]`, regular, 10, 0, 8);
    if (!format) return draw(`[${path}: not a PNG or JPEG image]`, regular, 10, 0, 8);
    const embedded = format === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const maxW = textW;
    const maxH = pageH - MARGIN * 2; // never require more than one full page
    const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1); // never upscale
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    if (y - h < MARGIN) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - MARGIN;
    }
    y -= h;
    page.drawImage(embedded, { x: MARGIN, y, width: w, height: h });
    y -= 8;
    if (alt) draw(alt, regular, 9, 0, 8);
  };

  const TABLE_FONT_SIZE = 9;
  const CELL_PAD_X = 4;
  const CELL_PAD_Y = 4;
  const BORDER = rgb(0.7, 0.7, 0.7);
  const HEADER_FILL = rgb(0.92, 0.92, 0.92);

  const drawTable = (header: string[], align: Align[], bodyRows: string[][]) => {
    const cols = header.length;
    if (cols === 0) return;
    const colW = textW / cols;
    const rows = [header, ...bodyRows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? ""))];

    rows.forEach((row, rowIndex) => {
      const isHeader = rowIndex === 0;
      const font = isHeader ? bold : regular;
      const lineH = TABLE_FONT_SIZE * 1.3;
      const cellLines = row.map((cell) => wrap(font, TABLE_FONT_SIZE, encodable(font, cell, stats), colW - CELL_PAD_X * 2));
      const rowH = Math.max(1, ...cellLines.map((l) => l.length)) * lineH + CELL_PAD_Y * 2;

      if (y - rowH < MARGIN) {
        page = doc.addPage([pageW, pageH]);
        y = pageH - MARGIN;
      }
      const rowTop = y;
      if (isHeader) {
        page.drawRectangle({ x: MARGIN, y: rowTop - rowH, width: textW, height: rowH, color: HEADER_FILL });
      }
      cellLines.forEach((lines, c) => {
        const cellX = MARGIN + c * colW;
        page.drawRectangle({ x: cellX, y: rowTop - rowH, width: colW, height: rowH, borderColor: BORDER, borderWidth: 0.5 });
        lines.forEach((line, li) => {
          const lineY = rowTop - CELL_PAD_Y - (li + 1) * lineH + (lineH - TABLE_FONT_SIZE) / 2;
          const w = font.widthOfTextAtSize(line, TABLE_FONT_SIZE);
          const cellAlign = align[c] ?? "left";
          const x =
            cellAlign === "center"
              ? cellX + (colW - w) / 2
              : cellAlign === "right"
                ? cellX + colW - CELL_PAD_X - w
                : cellX + CELL_PAD_X;
          page.drawText(line, { x, y: lineY, size: TABLE_FONT_SIZE, font, color: rgb(0.1, 0.1, 0.1) });
        });
      });
      y = rowTop - rowH;
    });
    y -= 8;
  };

  if (opts.title) draw(opts.title, bold, 22, 0, 14);
  for (const block of parseBlocks(opts.content)) {
    if (block.kind === "h1") draw(block.text, bold, 17, 0, 8);
    else if (block.kind === "h2") draw(block.text, bold, 14, 0, 6);
    else if (block.kind === "li") draw(`• ${block.text}`, regular, 11, 12, 3);
    else if (block.kind === "img") await drawImage(block.alt, block.path);
    else if (block.kind === "table") drawTable(block.header, block.align, block.rows);
    else {
      // Each input line is its own forced break; only the paragraph's last
      // line gets the normal gap-after, so lines within it stay tight.
      const { lines } = block;
      lines.forEach((line, i) => draw(line, regular, 11, 0, i === lines.length - 1 ? 8 : 0));
    }
  }

  return { bytes: await doc.save(), unsupportedChars: stats.replaced };
}

// ---------------------------------------------------------------------------
// Tools

export const pdfCreate = defineTool({
  name: "pdf_create",
  title: "Create PDF",
  kind: "write",
  description:
    "Create a new PDF from text. `content` supports a small Markdown subset: lines starting with " +
    "'# ' or '## ' are headings, '- ' are bullets, blank lines separate paragraphs, '![alt](path)' " +
    "on its own line embeds a PNG/JPEG image (upload it into the workspace with upload_file first, " +
    "then reference that same path), and a GFM-style pipe table (a header row, a |---|---| " +
    "separator — ':---'/'---:'/':---:' set column alignment — then body rows) renders as a real " +
    "bordered table. Only Latin characters render in text; others are replaced with '?'. Fails if " +
    "the file exists unless overwrite is true.",
  inputSchema: z.object({
    path: pdfPath,
    title: z.string().optional().describe("Shown as the first heading and stored as document metadata"),
    author: z.string().optional(),
    content: z.string().describe("Body text in the Markdown subset described above"),
    page_size: z.enum(["A4", "Letter"]).default("A4"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const images: Record<string, Uint8Array> = {};
    for (const imgPath of imagePaths(input.content)) {
      images[imgPath] = await readWorkspaceFile(ctx, imgPath);
    }
    const { bytes, unsupportedChars } = await buildPdf({
      title: input.title,
      author: input.author,
      content: input.content,
      pageSize: input.page_size,
      images,
    });
    const saved = await writeWorkspaceFile(ctx, input.path, bytes, input.overwrite);
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    const warning =
      unsupportedChars > 0
        ? ` — note: ${unsupportedChars} character(s) outside the supported Latin set were replaced with "?"`
        : "";
    return [
      { type: "text", text: `Created ${saved} (${pages} page(s), ${bytes.byteLength} bytes)${warning}` },
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
      title: info.Title || null,
      author: info.Author || null,
      creator: info.Creator || null,
      producer: info.Producer || null,
      created: info.CreationDate || null,
      modified: info.ModDate || null,
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
