import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  acknowledgePublicMemoryDisplay,
  MemoryUseExecutionError,
  PublicMemoryDisplayError,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../../../public-principal";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; runId: string }> },
) {
  const { slug, runId } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return privateJson(
        { error: "Representative is not publicly available." },
        runtime.status === "paused" ? 423 : 404,
      );
    }

    const outputMessageId = readOutputMessageId(
      await request.json().catch(() => null),
    );
    const { principal, sessionState } =
      await resolvePublicAudienceRequestPrincipal({
        representativeSlug: slug,
        cookieStore: await cookies(),
      });
    const acknowledgement = await acknowledgePublicMemoryDisplay({
      representativeSlug: slug,
      generationRunId: runId,
      outputMessageId,
      audienceIdentityId: principal.audienceIdentityId,
      audienceId: principal.audienceId,
    });

    const response = privateJson(acknowledgement, 200);
    setPublicAudienceSessionCookie(
      response,
      request,
      slug,
      sessionState,
    );
    return response;
  } catch (error) {
    const principalStatus = publicAudiencePrincipalErrorStatus(error);
    if (principalStatus) {
      return privateJson(
        {
          error:
            principalStatus === 401
              ? "Authentication required."
              : "Audience account requires reconciliation.",
        },
        principalStatus,
      );
    }
    if (
      error instanceof PublicMemoryDisplayError
      || error instanceof MemoryUseExecutionError
    ) {
      const status = error instanceof PublicMemoryDisplayError
        ? error.status
        : error.statusCode;
      return privateJson(
        {
          error:
            status === 404
              ? "Generation output not found."
              : status === 409
                ? "Generation output is not ready for display acknowledgement."
                : "Invalid display acknowledgement.",
          code: error.code,
        },
        status,
      );
    }
    console.error("Failed to acknowledge public memory display.", error);
    return privateJson(
      { error: "Failed to acknowledge displayed context." },
      500,
    );
  }
}

function readOutputMessageId(payload: unknown) {
  const candidate = (payload ?? {}) as Record<string, unknown>;
  if (
    typeof candidate.outputMessageId !== "string"
    || !candidate.outputMessageId.trim()
    || candidate.outputMessageId.trim().length > 200
  ) {
    throw new PublicMemoryDisplayError(
      "public_memory_display_invalid_input",
      "outputMessageId is required.",
      400,
    );
  }
  return candidate.outputMessageId.trim();
}

function privateJson(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
