import { NextResponse } from "next/server";
import JSZip from "jszip";
import { requireDashboardApiOwnerSession } from "../../auth";
import { knowledgeErrorResponse } from "../route";

const files = ["manifest.json", "popup.html", "popup.js", "popup.css", "capture.js", "README.txt"];

export async function GET() {
  try {
    await requireDashboardApiOwnerSession();
    const zip = new JSZip();
    // Read the fixed bundle locally; never fetch a request-controlled URL.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = process.cwd();
    for (const file of files) {
      let bytes: Buffer;
      try { bytes = await readFile(join(root, "public/knowledge-collector", file)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        bytes = await readFile(join(root, "apps/web/public/knowledge-collector", file));
      }
      zip.file(file, bytes);
    }
    const bytes = await zip.generateAsync({ type: "uint8array" });
    return new NextResponse(new Uint8Array(bytes).buffer, {
      headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="delegate-knowledge-collector.zip"', "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to download browser collector.");
  }
}
