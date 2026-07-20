import { cookies } from "next/headers";

import {
  buildWebAudienceKey,
  getPublicGenerationRunSnapshot,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  readPublicChatSessionState,
} from "../../../../public-chat";

const encoder = new TextEncoder();
const terminalStates = new Set(["waiting_approval", "completed", "failed", "canceled"]);
const RUN_STREAM_WINDOW_MS = 120_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; runId: string }> },
) {
  const { slug, runId } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") {
    return new Response(JSON.stringify({ error: "Representative is not publicly available." }), {
      status: runtime.status === "paused" ? 423 : 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const cookieStore = await cookies();
  const session = readPublicChatSessionState({
    representativeSlug: slug,
    cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
  });
  const audienceKey = buildWebAudienceKey(session.audienceId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let previous = "";
      try {
        while (!request.signal.aborted && Date.now() - startedAt < RUN_STREAM_WINDOW_MS) {
          const snapshot = await getPublicGenerationRunSnapshot({
            representativeSlug: slug,
            runId,
            audienceKey,
          });
          if (!snapshot) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "run_not_found" })}\n\n`));
            break;
          }

          const serialized = JSON.stringify(snapshot);
          if (serialized !== previous) {
            controller.enqueue(encoder.encode(`event: run\ndata: ${serialized}\n\n`));
            previous = serialized;
          } else {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
          if (terminalStates.has(snapshot.status)) break;
          await wait(500, request.signal);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : "stream_failed" })}\n\n`,
            ),
          );
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
