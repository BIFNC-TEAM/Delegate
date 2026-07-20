import { listConversationInboxSnapshot } from "@delegate/web-data";

import { requireDashboardRepresentativeAccess } from "../../../../auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const session = await requireDashboardRepresentativeAccess(slug);
  const operatorId = session?.ownerId || "local-owner";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let previous = "";
      const send = async () => {
        const snapshot = await listConversationInboxSnapshot(slug, operatorId);
        if (!snapshot) {
          controller.enqueue(encoder.encode("event: unavailable\ndata: {}\n\n"));
          return;
        }
        const serialized = JSON.stringify(snapshot);
        if (serialized !== previous) {
          previous = serialized;
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
        } else {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }
      };

      try {
        await send();
        while (!request.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (request.signal.aborted) break;
          await send();
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : "stream_failed" })}\n\n`,
          ),
        );
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
