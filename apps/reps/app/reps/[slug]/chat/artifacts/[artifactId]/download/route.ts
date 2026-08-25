import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  getPublicConversationArtifactDownload,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../../../../public-principal";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; artifactId: string }> },
) {
  const { slug, artifactId } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") {
    return NextResponse.json(
      { error: "Representative is not publicly available." },
      { status: runtime.status === "paused" ? 423 : 404 },
    );
  }

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
  const { principal, sessionState } = audienceRequest;
  const artifact = await getPublicConversationArtifactDownload({
    representativeSlug: slug,
    artifactId,
    audienceIdentityId: principal.audienceIdentityId,
  });
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const response = new NextResponse(new Uint8Array(artifact.buffer), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": artifact.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.fileName}"`,
      "X-Content-Type-Options": "nosniff",
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
