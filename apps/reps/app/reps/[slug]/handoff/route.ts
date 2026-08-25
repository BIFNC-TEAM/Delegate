import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  controlPublicAudienceHandoff,
  getPublicRepresentativeRuntime,
  PublicAudienceHandoffControlError,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../public-principal";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") {
    return noStoreJson(
      { error: "Representative is not publicly available." },
      runtime.status === "paused" ? 423 : 404,
    );
  }

  try {
    const action = await readHandoffAction(request);
    const audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });
    await audienceRequest.revalidate();
    const result = await controlPublicAudienceHandoff({
      representativeSlug: slug,
      audienceIdentityId:
        audienceRequest.principal.audienceIdentityId,
      audienceId: audienceRequest.principal.audienceId,
      action,
    });
    const response = noStoreJson(result);
    setPublicAudienceSessionCookie(
      response,
      request,
      slug,
      audienceRequest.sessionState,
    );
    return response;
  } catch (error) {
    const principalStatus = publicAudiencePrincipalErrorStatus(error);
    if (principalStatus) {
      return noStoreJson(
        { error: "The public conversation session is no longer valid." },
        principalStatus,
      );
    }
    if (error instanceof PublicAudienceHandoffControlError) {
      return noStoreJson(
        { error: error.message, code: error.code },
        error.statusCode,
      );
    }
    return noStoreJson(
      { error: "Unable to update human service right now." },
      500,
    );
  }
}

async function readHandoffAction(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new PublicAudienceHandoffControlError(
      "invalid_request",
      "A JSON request body is required.",
      400,
    );
  }
  const action = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).action
    : null;
  if (action !== "cancel_request" && action !== "end_human_service") {
    throw new PublicAudienceHandoffControlError(
      "invalid_action",
      "Unsupported human-service action.",
      400,
    );
  }
  return action;
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
    },
  });
}
