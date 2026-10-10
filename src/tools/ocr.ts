import os from "node:os";
import path from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import { z } from "zod";
import { defineTool, ToolError } from "./types.js";
import { readWorkspaceFile } from "./workspace.js";

// Tesseract's language model (~a few MB) downloads from its CDN on first use and is
// cached here for every call after that, for the life of the container — not inside
// the workspace, since it's engine state, not a user file. A container restart loses
// the cache and re-downloads once; that's an acceptable cost for a personal tool.
const CACHE_DIR = path.join(os.tmpdir(), "claude-tools-tesseract-cache");

// Spinning up a worker loads the language model, which isn't cheap — reuse one across
// calls instead of a fresh one per request. Tesseract.js queues recognize() calls on a
// single worker internally, so concurrent OCR requests serialize safely rather than
// racing each other.
let workerPromise: Promise<Worker> | null = null;
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, { cachePath: CACHE_DIR }).catch((err: unknown) => {
      workerPromise = null; // don't cache a permanent failure — let the next call retry
      throw err;
    });
  }
  return workerPromise;
}

export const ocrExtract = defineTool({
  name: "ocr_extract",
  title: "Extract text from an image (OCR)",
  kind: "read",
  description:
    "Run OCR on an image already in the workspace (upload it first with upload_file) and return " +
    "the text found in it — for scanned documents, ID cards, certificates, or any image with no " +
    "real text layer. English only for now. The first call after the server starts is slower " +
    "while it downloads and loads the language model; later calls reuse it.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Image file already in the workspace"),
  }),
  async run(input, ctx) {
    const data = await readWorkspaceFile(ctx, input.path);

    let worker: Worker;
    try {
      worker = await getWorker();
    } catch (err) {
      throw new ToolError(`Couldn't start the OCR engine: ${(err as Error).message}`);
    }

    let result: { text: string; confidence: number };
    try {
      ({ data: result } = await worker.recognize(Buffer.from(data)));
    } catch (err) {
      throw new ToolError(`OCR failed on ${input.path}: ${(err as Error).message}`);
    }

    const confidence = Math.round(result.confidence);
    const text = result.text.trim();
    if (!text) {
      return [{ type: "text", text: `${input.path}: no text found (confidence ${confidence}%)` }];
    }
    return [{ type: "text", text: `${input.path} (confidence ${confidence}%):\n\n${text}` }];
  },
});

export const ocrTools = [ocrExtract];
