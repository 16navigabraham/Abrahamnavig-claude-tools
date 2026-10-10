import sharp from "sharp";
import { z } from "zod";
import { linkLine } from "./files.js";
import { defineTool, ToolError } from "./types.js";
import { readWorkspaceFile, writeWorkspaceFile } from "./workspace.js";

const FORMATS = ["png", "jpeg", "webp"] as const;
type Format = (typeof FORMATS)[number];

export const imageEdit = defineTool({
  name: "image_edit",
  title: "Resize / convert / compress image",
  kind: "write",
  description:
    "Resize, convert format (PNG/JPEG/WebP) and/or compress an image already in the workspace " +
    "(upload it first with upload_file). Any combination of width/height/format/quality can be " +
    "set in one call — omit `output` to edit the file in place. Resizing only ever shrinks, never " +
    "enlarges, and keeps the original aspect ratio.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Existing image in the workspace"),
    output: z.string().min(1).optional().describe("Destination path; omit to overwrite `path` itself"),
    format: z.enum(FORMATS).optional().describe("Convert to this format; default keeps the source format where possible"),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    quality: z.number().int().min(1).max(100).optional().describe("Compression quality for jpeg/webp (ignored for png)"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const data = await readWorkspaceFile(ctx, input.path);
    const meta = await sharp(data, { failOn: "none" }).metadata();
    if (!meta.format) throw new ToolError(`${input.path} doesn't look like an image sharp can read`);

    let pipeline = sharp(data, { failOn: "none" });
    if (input.width || input.height) {
      pipeline = pipeline.resize({
        width: input.width,
        height: input.height,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const sourceIsSupported = (FORMATS as readonly string[]).includes(meta.format);
    const targetFormat: Format = input.format ?? (sourceIsSupported ? (meta.format as Format) : "png");
    const { data: out, info } = await pipeline
      .toFormat(targetFormat, targetFormat === "png" ? {} : { quality: input.quality ?? 80 })
      .toBuffer({ resolveWithObject: true });

    const dest = input.output ?? input.path;
    // Editing in place is inherently a replace; writing to a NEW path still needs explicit opt-in.
    const allowOverwrite = input.output ? input.overwrite : true;
    const saved = await writeWorkspaceFile(ctx, dest, out, allowOverwrite);
    return [
      {
        type: "text",
        text:
          `Converted ${input.path} (${meta.width}x${meta.height}, ${data.byteLength} bytes) to ` +
          `${saved} (${info.width}x${info.height}, ${out.length} bytes, ${targetFormat})`,
      },
      ...linkLine(ctx, saved),
    ];
  },
});

export const imageTools = [imageEdit];
