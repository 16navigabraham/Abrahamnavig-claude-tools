import fs from "node:fs/promises";
import path from "node:path";
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
  // A line that is exactly `\pagebreak` forces the next block onto a new page.
  | { kind: "pagebreak" }
  // A paragraph is its own input lines, not one joined string: a single line
  // break stays a line break (drawn as a forced break), a blank line starts a
  // new paragraph (drawn with the usual gap after).
  | { kind: "p"; lines: string[] };

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const PAGE_BREAK = "\\pagebreak";
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
    } else if (line === PAGE_BREAK) {
      flush();
      blocks.push({ kind: "pagebreak" });
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

/** Cells narrower than this fraction of the table are kept on one line when the table allows it. */
const SHORT_CELL_FRACTION = 0.2;

/**
 * Column widths for a table, sized to content instead of split evenly: each column
 * wants its widest cell on one line (`natural`) and can't usefully go below its
 * longest word, or below a short cell's full width (`min`). If every column fits on
 * one line, the spare width is shared out in proportion; otherwise each column gets
 * its minimum plus a share of the remaining width in proportion to how much it would
 * still need to stop wrapping. `cellWidth` measures one cell's text (bold for the
 * header row) without padding.
 */
export function tableColumnWidths(
  rows: string[][],
  cellWidth: (text: string, rowIndex: number) => number,
  totalW: number,
  padX: number,
): number[] {
  const cols = rows[0]?.length ?? 0;
  const natural = new Array<number>(cols).fill(0);
  const min = new Array<number>(cols).fill(0);
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      const text = row[c] ?? "";
      const full = cellWidth(text, r) + padX * 2;
      natural[c] = Math.max(natural[c], full);
      // A short cell (a number, a header like "Cost (NGN)") shouldn't wrap at all;
      // a long one may wrap down to its longest word.
      if (full <= totalW * SHORT_CELL_FRACTION) min[c] = Math.max(min[c], full);
      for (const word of text.split(/\s+/).filter(Boolean)) {
        min[c] = Math.max(min[c], cellWidth(word, r) + padX * 2);
      }
    }
  });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const sumNatural = sum(natural);
  if (sumNatural === 0) return new Array<number>(cols).fill(totalW / cols);
  if (sumNatural <= totalW) return natural.map((w) => (w / sumNatural) * totalW);
  const sumMin = sum(min);
  if (sumMin >= totalW) return min.map((w) => (w / sumMin) * totalW);
  const need = natural.map((w, c) => w - min[c]);
  const sumNeed = sum(need);
  return min.map((w, c) => w + ((totalW - sumMin) * need[c]) / sumNeed);
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
  const TOP = pageH - MARGIN;
  let y = TOP;
  const stats = { replaced: 0 };

  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    y = TOP;
  };
  /** Start a new page unless `h` points still fit (or the page is already fresh). */
  const ensureSpace = (h: number) => {
    if (y - h < MARGIN && y < TOP) newPage();
  };

  const textLines = (text: string, font: PDFFont, size: number, indent = 0) =>
    wrap(font, size, encodable(font, text, stats), textW - indent);

  const draw = (text: string, font: PDFFont, size: number, indent = 0, gapAfter = 6) => {
    const lineH = size * 1.35;
    for (const line of textLines(text, font, size, indent)) {
      if (y - lineH < MARGIN) newPage();
      y -= lineH;
      page.drawText(line, { x: MARGIN + indent, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= gapAfter;
  };

  // Embed every referenced image up front, so its size is known when deciding
  // whether a heading above it still fits on the current page.
  type Embedded = Awaited<ReturnType<typeof doc.embedPng>>;
  const embedded = new Map<string, Embedded | null>();
  for (const [imgPath, bytes] of Object.entries(images)) {
    const format = sniffImageFormat(bytes);
    embedded.set(imgPath, format === "png" ? await doc.embedPng(bytes) : format === "jpg" ? await doc.embedJpg(bytes) : null);
  }
  const imageSize = (img: Embedded) => {
    const scale = Math.min(textW / img.width, (pageH - MARGIN * 2) / img.height, 1); // never upscale
    return { w: img.width * scale, h: img.height * scale };
  };

  const drawImage = (alt: string, path: string) => {
    const img = embedded.get(path);
    if (!images[path]) return draw(`[image not found: ${path}]`, regular, 10, 0, 8);
    if (!img) return draw(`[${path}: not a PNG or JPEG image]`, regular, 10, 0, 8);
    const { w, h } = imageSize(img);
    ensureSpace(h);
    y -= h;
    page.drawImage(img, { x: MARGIN, y, width: w, height: h });
    y -= 8;
    if (alt) draw(alt, regular, 9, 0, 8);
  };

  const TABLE_FONT_SIZE = 9;
  const TABLE_LINE_H = TABLE_FONT_SIZE * 1.3;
  const CELL_PAD_X = 4;
  const CELL_PAD_Y = 4;
  const BORDER = rgb(0.7, 0.7, 0.7);
  const HEADER_FILL = rgb(0.92, 0.92, 0.92);

  /** Column widths plus each row's wrapped cell lines and height; row 0 is the header. */
  const layoutTable = (header: string[], bodyRows: string[][]) => {
    const cols = header.length;
    const rows = [header, ...bodyRows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? ""))];
    const fontFor = (r: number) => (r === 0 ? bold : regular);
    const colW = tableColumnWidths(
      rows,
      (text, r) => fontFor(r).widthOfTextAtSize(encodable(fontFor(r), text, { replaced: 0 }), TABLE_FONT_SIZE),
      textW,
      CELL_PAD_X,
    );
    const laidOut = rows.map((row, r) => {
      const font = fontFor(r);
      const lines = row.map((cell, c) => wrap(font, TABLE_FONT_SIZE, encodable(font, cell, stats), colW[c] - CELL_PAD_X * 2));
      const height = Math.max(1, ...lines.map((l) => l.length)) * TABLE_LINE_H + CELL_PAD_Y * 2;
      return { font, lines, height };
    });
    return { colW, rows: laidOut };
  };

  const drawTable = (header: string[], align: Align[], bodyRows: string[][]) => {
    if (header.length === 0) return;
    const { colW, rows } = layoutTable(header, bodyRows);

    const drawRow = (row: (typeof rows)[number], isHeader: boolean) => {
      const rowTop = y;
      const rowH = row.height;
      if (isHeader) {
        page.drawRectangle({ x: MARGIN, y: rowTop - rowH, width: textW, height: rowH, color: HEADER_FILL });
      }
      let cellX = MARGIN;
      row.lines.forEach((lines, c) => {
        const w0 = colW[c];
        page.drawRectangle({ x: cellX, y: rowTop - rowH, width: w0, height: rowH, borderColor: BORDER, borderWidth: 0.5 });
        lines.forEach((line, li) => {
          const lineY = rowTop - CELL_PAD_Y - (li + 1) * TABLE_LINE_H + (TABLE_LINE_H - TABLE_FONT_SIZE) / 2;
          const w = row.font.widthOfTextAtSize(line, TABLE_FONT_SIZE);
          const cellAlign = align[c] ?? "left";
          const x =
            cellAlign === "center"
              ? cellX + (w0 - w) / 2
              : cellAlign === "right"
                ? cellX + w0 - CELL_PAD_X - w
                : cellX + CELL_PAD_X;
          page.drawText(line, { x, y: lineY, size: TABLE_FONT_SIZE, font: row.font, color: rgb(0.1, 0.1, 0.1) });
        });
        cellX += w0;
      });
      y = rowTop - rowH;
    };

    // Never leave the header alone at the bottom of a page: it moves with the first body row.
    const [headerRow, ...body] = rows;
    ensureSpace(headerRow.height + (body[0]?.height ?? 0));
    drawRow(headerRow, true);
    for (const row of body) {
      if (y - row.height < MARGIN) {
        // Continue on a new page and repeat the header so the columns stay labelled.
        newPage();
        drawRow(headerRow, true);
      }
      drawRow(row, false);
    }
    y -= 8;
  };

  /** Height of the start of a block: what a heading above it needs alongside it on the same page. */
  const leadHeight = (block: Block | undefined): number => {
    if (!block) return 0;
    if (block.kind === "p" || block.kind === "li") return 11 * 1.35;
    if (block.kind === "table") {
      if (block.header.length === 0) return 0;
      const { rows } = layoutTable(block.header, block.rows.slice(0, 1));
      return rows.reduce((h, r) => h + r.height, 0);
    }
    if (block.kind === "img") {
      const img = embedded.get(block.path);
      return img ? imageSize(img).h : 10 * 1.35;
    }
    return 0; // headings and page breaks don't pull anything along
  };

  const heading = (text: string, size: number, gapAfter: number, next: Block | undefined) => {
    const h = textLines(text, bold, size).length * size * 1.35 + gapAfter + leadHeight(next);
    // Keep the heading with the start of what follows it, unless that alone won't fit on a page.
    if (h <= pageH - MARGIN * 2) ensureSpace(h);
    draw(text, bold, size, 0, gapAfter);
  };

  if (opts.title) draw(opts.title, bold, 22, 0, 14);
  const blocks = parseBlocks(opts.content);
  blocks.forEach((block, i) => {
    const next = blocks[i + 1];
    if (block.kind === "h1") heading(block.text, 17, 8, next);
    else if (block.kind === "h2") heading(block.text, 14, 6, next);
    else if (block.kind === "pagebreak") {
      if (y < TOP) newPage(); // a break at the top of a fresh page would only add a blank page
    } else if (block.kind === "li") draw(`• ${block.text}`, regular, 11, 12, 3);
    else if (block.kind === "img") drawImage(block.alt, block.path);
    else if (block.kind === "table") drawTable(block.header, block.align, block.rows);
    else {
      // Each input line is its own forced break; only the paragraph's last
      // line gets the normal gap-after, so lines within it stay tight.
      const { lines } = block;
      lines.forEach((line, li) => draw(line, regular, 11, 0, li === lines.length - 1 ? 8 : 0));
    }
  });

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
    "bordered table with columns sized to their content. A line that is exactly '\\pagebreak' starts " +
    "a new page; headings are kept on the same page as what follows them. Only Latin characters " +
    "render in text; others are replaced with '?'. Fails if " +
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

export const pdfSplit = defineTool({
  name: "pdf_split",
  title: "Split / extract PDF pages",
  kind: "write",
  description: "Extract a page range from a PDF into a new PDF, e.g. to pull one paper out of a merged pack.",
  inputSchema: z.object({
    path: pdfPath,
    output: pdfPath,
    start_page: z.number().int().min(1).default(1),
    end_page: z.number().int().min(1).optional().describe("Inclusive. Defaults to the last page"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const src = await PDFDocument.load(await readWorkspaceFile(ctx, input.path));
    const total = src.getPageCount();
    const end = Math.min(input.end_page ?? total, total);
    if (input.start_page > end) {
      throw new ToolError(`start_page ${input.start_page} is past the end (${total} pages)`);
    }
    const indices: number[] = [];
    for (let i = input.start_page; i <= end; i++) indices.push(i - 1);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    const saved = await writeWorkspaceFile(ctx, input.output, bytes, input.overwrite);
    return [
      { type: "text", text: `Extracted pages ${input.start_page}-${end} of ${total} from ${input.path} into ${saved}` },
      ...linkLine(ctx, saved),
    ];
  },
});

export const pdfSearch = defineTool({
  name: "pdf_search",
  title: "Search text in PDFs",
  kind: "read",
  description:
    "Search for text across all PDFs in the workspace, or within one PDF if path is given. Case-insensitive, " +
    "matches a plain substring (not a regex). Returns the page and a snippet of context for each match.",
  inputSchema: z.object({
    query: z.string().min(1),
    path: pdfPath.optional().describe("Search only this PDF; omit to search every PDF in the workspace"),
    max_results: z.number().int().min(1).max(200).default(50),
  }),
  async run(input, ctx) {
    let targets: string[];
    if (input.path) {
      targets = [input.path];
    } else {
      targets = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile() && /\.pdf$/i.test(e.name)) targets.push(path.relative(ctx.workspace, full));
        }
      };
      await walk(ctx.workspace);
      if (targets.length === 0) return [{ type: "text", text: "No PDFs in the workspace." }];
    }

    const needle = input.query.toLowerCase();
    const results: string[] = [];
    for (const rel of targets) {
      let text: string[];
      try {
        const data = await readWorkspaceFile(ctx, rel);
        ({ text } = await extractText(await getDocumentProxy(data), { mergePages: false }));
      } catch (err) {
        if (input.path) throw err;
        continue;
      }
      for (let i = 0; i < text.length; i++) {
        const pageText = text[i] || "";
        const lower = pageText.toLowerCase();
        let idx = lower.indexOf(needle);
        while (idx !== -1) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(pageText.length, idx + needle.length + 40);
          const snippet = pageText.slice(start, end).replace(/\s+/g, " ").trim();
          results.push(`${rel} p.${i + 1}: …${snippet}…`);
          if (results.length >= input.max_results) {
            return [{ type: "text", text: results.join("\n") + `\n\n(stopped at ${input.max_results} results)` }];
          }
          idx = lower.indexOf(needle, idx + needle.length);
        }
      }
    }
    if (results.length === 0) {
      return [{ type: "text", text: `No matches for "${input.query}" in ${input.path ?? `${targets.length} PDF(s)`}` }];
    }
    return [{ type: "text", text: results.join("\n") }];
  },
});

export const pdfTools = [pdfCreate, pdfRead, pdfInfo, pdfView, pdfMerge, pdfSplit, pdfSearch];
