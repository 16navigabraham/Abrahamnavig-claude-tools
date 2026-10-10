import { z } from "zod";
import { linkLine } from "./files.js";
import { defineTool } from "./types.js";
import { writeWorkspaceFile } from "./workspace.js";

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** RFC 4180-ish: quote a value only when it needs it, doubling any embedded quotes. */
function escapeCell(v: z.infer<typeof cell>): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvCreate = defineTool({
  name: "csv_create",
  title: "Create CSV",
  kind: "write",
  description:
    "Create a CSV file from column headers and rows of data — for a comparison table, a list, or " +
    "anything tabular, instead of formatting it as prose inside a PDF.",
  inputSchema: z.object({
    path: z.string().min(1).regex(/\.csv$/i, "Path must end in .csv"),
    headers: z.array(z.string()).optional().describe("Optional header row"),
    rows: z.array(z.array(cell)).describe("Row data; each row is an array of cell values"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const lines: string[] = [];
    if (input.headers) lines.push(input.headers.map(escapeCell).join(","));
    for (const row of input.rows) lines.push(row.map(escapeCell).join(","));
    const csv = lines.join("\r\n") + (lines.length ? "\r\n" : "");
    const saved = await writeWorkspaceFile(ctx, input.path, Buffer.from(csv, "utf8"), input.overwrite);
    return [
      { type: "text", text: `Created ${saved} (${input.rows.length} row(s)${input.headers ? " + header" : ""})` },
      ...linkLine(ctx, saved),
    ];
  },
});

export const csvTools = [csvCreate];
