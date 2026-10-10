import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvCreate } from "../src/tools/csv.js";
import type { ToolContext } from "../src/tools/types.js";

let ctx: ToolContext;

beforeEach(async () => {
  ctx = { workspace: await fs.mkdtemp(path.join(os.tmpdir(), "claude-tools-csv-")) };
});
afterEach(async () => {
  await fs.rm(ctx.workspace, { recursive: true, force: true });
});

describe("csv_create", () => {
  it("writes headers and rows as proper CSV, CRLF-terminated", async () => {
    const [res] = await csvCreate.run(
      csvCreate.inputSchema.parse({
        path: "compare.csv",
        headers: ["Provider", "Fee", "Notes"],
        rows: [
          ["Anchor", 1.5, "Simple, no caps"],
          ["Interswitch", 2, null],
        ],
      }),
      ctx,
    );
    expect(res.type === "text" && res.text).toContain("2 row(s) + header");

    const out = await fs.readFile(path.join(ctx.workspace, "compare.csv"), "utf8");
    expect(out).toBe('Provider,Fee,Notes\r\nAnchor,1.5,"Simple, no caps"\r\nInterswitch,2,\r\n');
  });

  it("quotes cells containing commas, quotes or newlines, doubling embedded quotes", async () => {
    await csvCreate.run(
      csvCreate.inputSchema.parse({ path: "quoting.csv", rows: [['He said "hi"', "a,b", "line1\nline2", true]] }),
      ctx,
    );
    const out = await fs.readFile(path.join(ctx.workspace, "quoting.csv"), "utf8");
    expect(out).toBe('"He said ""hi""","a,b","line1\nline2",true\r\n');
  });

  it("works with no headers", async () => {
    const [res] = await csvCreate.run(csvCreate.inputSchema.parse({ path: "plain.csv", rows: [["a", "b"]] }), ctx);
    expect(res.type === "text" && res.text).not.toContain("header");
    const out = await fs.readFile(path.join(ctx.workspace, "plain.csv"), "utf8");
    expect(out).toBe("a,b\r\n");
  });

  it("refuses to overwrite unless asked", async () => {
    await csvCreate.run(csvCreate.inputSchema.parse({ path: "x.csv", rows: [["a"]] }), ctx);
    await expect(csvCreate.run(csvCreate.inputSchema.parse({ path: "x.csv", rows: [["b"]] }), ctx)).rejects.toThrow(/already exists/);
  });
});
