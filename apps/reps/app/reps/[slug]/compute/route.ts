import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  getPublicRepresentativeRuntime,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
} from "@delegate/web-data";

import {
  createWebAudienceComputeSession,
  normalizePublicComputeSessionRequest,
} from "../web-compute";
import {
  assertPublicAudienceResourceOwner,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../public-principal";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });
    const representative = runtime.setup;
    if (!representative.compute.enabled) {
      return NextResponse.json(
        { error: "Compute is disabled for this representative." },
        { status: 409 },
      );
    }

    const body = normalizePublicComputeSessionRequest(await request.json());
    const { principal, sessionState } =
      await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });
    const contact = await resolveWebAudienceContact({
      representativeId: representative.id,
      representativeSlug: slug,
      audienceId: principal.audienceId,
    });
    assertPublicAudienceResourceOwner(principal, contact.audienceIdentityId);
    const conversation = await resolveWebAudienceConversation({
      representativeId: representative.id,
      contactId: contact.id,
      audienceId: principal.audienceId,
    });
    assertPublicAudienceResourceOwner(
      principal,
      conversation.audienceIdentityId,
    );

    const computeSession = await createWebAudienceComputeSession({
      representativeId: representative.id,
      contactId: contact.id,
      conversationId: conversation.id,
      ...body,
    });

    const response = NextResponse.json(computeSession, { status: 201 });
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
      return NextResponse.json(
        {
          error:
            principalStatus === 401
              ? "Authentication required."
              : "Audience account requires reconciliation.",
        },
        {
          status: principalStatus,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    return NextResponse.json(
      { error: "Failed to create public compute session." },
      {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
