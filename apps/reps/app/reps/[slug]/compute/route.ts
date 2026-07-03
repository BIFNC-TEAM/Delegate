import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  getRepresentativeSetupSnapshot,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
  readPublicChatSessionState,
  writePublicChatSessionState,
} from "../public-chat";
import {
  createWebAudienceComputeSession,
  normalizePublicComputeSessionRequest,
} from "../web-compute";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const representative = await getRepresentativeSetupSnapshot(slug);
    if (!representative) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }
    if (!representative.compute.enabled) {
      return NextResponse.json(
        { error: "Compute is disabled for this representative." },
        { status: 409 },
      );
    }

    const body = normalizePublicComputeSessionRequest(await request.json());
    const cookieStore = await cookies();
    const sessionState = readPublicChatSessionState({
      representativeSlug: slug,
      cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
    });
    const contact = await resolveWebAudienceContact({
      representativeId: representative.id,
      representativeSlug: slug,
      audienceId: sessionState.audienceId,
    });
    const conversation = await resolveWebAudienceConversation({
      representativeId: representative.id,
      contactId: contact.id,
      audienceId: sessionState.audienceId,
    });

    const computeSession = await createWebAudienceComputeSession({
      representativeId: representative.id,
      contactId: contact.id,
      conversationId: conversation.id,
      ...body,
    });

    const response = NextResponse.json(computeSession, { status: 201 });
    response.cookies.set(
      getPublicChatCookieName(slug),
      writePublicChatSessionState({
        representativeSlug: slug,
        state: sessionState,
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS,
        path: `/reps/${slug}`,
      },
    );

    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create public compute session.",
      },
      { status: 400 },
    );
  }
}
