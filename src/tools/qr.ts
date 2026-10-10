import QRCode from "qrcode";
import { z } from "zod";
import { linkLine } from "./files.js";
import { defineTool } from "./types.js";
import { writeWorkspaceFile } from "./workspace.js";

export const qrCreate = defineTool({
  name: "qr_create",
  title: "Create QR code",
  kind: "write",
  description:
    "Generate a QR code PNG from text or a URL (an invite link, a payment link, anything meant to " +
    "be scanned) and save it into the workspace. Reference it as an image from pdf_create, or get " +
    "a download link to share it directly.",
  inputSchema: z.object({
    path: z.string().min(1).regex(/\.png$/i, "Path must end in .png"),
    data: z.string().min(1).describe("Text or URL to encode"),
    size: z.number().int().min(64).max(2048).default(512).describe("Image width/height in pixels"),
    overwrite: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const buf = await QRCode.toBuffer(input.data, { width: input.size, margin: 2 });
    const saved = await writeWorkspaceFile(ctx, input.path, buf, input.overwrite);
    return [
      { type: "text", text: `Created QR code ${saved} (${input.size}x${input.size}px, ${buf.length} bytes)` },
      ...linkLine(ctx, saved),
    ];
  },
});

export const qrTools = [qrCreate];
