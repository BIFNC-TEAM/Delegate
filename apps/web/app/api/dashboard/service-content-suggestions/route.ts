import { NextResponse } from "next/server";
import { generateServiceContentSuggestion, serviceContentInputSchema } from "@delegate/model-runtime";
import { dashboardAuthErrorResponse, requireDashboardApiOwnerSession } from "../auth";
import { withPrivateNoStore } from "../../private-response";

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(request: Request): Promise<{ tooLarge: boolean; value?: unknown }> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return { tooLarge: true };
  if (!request.body) return { tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) }; }
    catch { return { tooLarge: false }; }
  } finally {
    reader.releaseLock();
  }
}

const reply = (body: unknown, status = 200) => withPrivateNoStore(NextResponse.json(body, { status }));
export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    if (!session?.ownerId?.trim()) return reply({ error: "Authentication required." }, 401);
    const requestBody = await readBody(request);
    if (requestBody.tooLarge) return reply({ error: "Request too large." }, 413);
    const input = serviceContentInputSchema.safeParse(requestBody.value);
    if (!input.success) return reply({ error: "Invalid request." }, 400);
    const result = await generateServiceContentSuggestion(input.data);
    const { attempts: _attempts, ...body } = result;
    return reply(body, result.status === "timeout" ? 504 : result.status === "model_failure" ? 502 : result.status === "invalid_input" ? 400 : 200);
  } catch (error) {
    return dashboardAuthErrorResponse(error) ?? reply({ error: "Unable to process service content request." }, 500);
  }
}
