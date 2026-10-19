import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { auditErrorCode } from "@delegate/runtime";

import {
  getPublicGenerationRunSnapshot,
  getPublicGenerationRunControlSnapshot,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../../../public-principal";

const encoder = new TextEncoder();
const terminalStates = new Set(["waiting_approval", "waiting_human", "completed", "failed", "canceled"]);
const RUN_STREAM_WINDOW_MS = 300_000;
const PRINCIPAL_REVALIDATION_INTERVAL_MS = 2_000;
const RUN_STREAM_POLL_INTERVAL_MS = 150;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; runId: string }> },
) {
  const { slug, runId } = await params;
  let audienceRequest: Awaited<
    ReturnType<typeof resolvePublicAudienceRequestPrincipal>
  >;
  try {
    audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });
  } catch (error) {
    const status = publicAudiencePrincipalErrorStatus(error);
    if (!status) throw error;
    return NextResponse.json(
      {
        error:
          status === 401
            ? "Authentication required."
            : "Audience account requires reconciliation.",
      },
      {
        status,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  const { principal, revalidate, sessionState } = audienceRequest;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let previous = "";
      let nextPrincipalRevalidationAt = 0;
      let serviceAvailable = false;
      try {
        while (!request.signal.aborted && Date.now() - startedAt < RUN_STREAM_WINDOW_MS) {
          if (Date.now() >= nextPrincipalRevalidationAt) {
            await revalidate();
            serviceAvailable = (await getPublicRepresentativeRuntime(slug)).status === "available";
            nextPrincipalRevalidationAt =
              Date.now() + PRINCIPAL_REVALIDATION_INTERVAL_MS;
          }
          const readSnapshot = serviceAvailable ? getPublicGenerationRunSnapshot : getPublicGenerationRunControlSnapshot;
          const snapshot = await readSnapshot({
            representativeSlug: slug,
            runId,
            audienceIdentityId: principal.audienceIdentityId,
            audienceId: principal.audienceId,
            ...(new URL(request.url).searchParams.get("preview") === "1" ? { allowDraftPreview: true } : {}),
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
          await wait(RUN_STREAM_POLL_INTERVAL_MS, request.signal);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: "stream_failed" })}\n\n`,
            ),
          );
          console.error("Public generation run event stream failed.", auditErrorCode(error));
        }
      } finally {
        controller.close();
      }
    },
  });

  const response = new NextResponse(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
  setPublicAudienceSessionCookie(
    response,
    request,
    slug,
    sessionState,
  );
  return response;
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
