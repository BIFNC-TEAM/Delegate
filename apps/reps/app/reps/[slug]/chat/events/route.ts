import { cookies } from "next/headers";

import {
  buildWebAudienceKey,
  getPublicConversationHistory,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

import {
  deriveTierUsage,
  getPublicChatCookieName,
  readPublicChatSessionState,
} from "../../public-chat";

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
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
      let previous = "";
      try {
        while (!request.signal.aborted) {
          const history = await getPublicConversationHistory({
            representativeSlug: slug,
            audienceKey,
          });
          const snapshot = {
            ...history,
            usage: deriveTierUsage({
              freeRepliesUsed: history.freeRepliesUsed,
              freeReplyLimit: runtime.setup.contract.freeReplyLimit,
            }),
          };
          const serialized = JSON.stringify(snapshot);
          if (serialized !== previous) {
            previous = serialized;
            controller.enqueue(encoder.encode(`event: conversation\ndata: ${serialized}\n\n`));
          } else {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
          await wait(500, request.signal);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
            error: error instanceof Error ? error.message : "stream_failed",
          })}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
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
