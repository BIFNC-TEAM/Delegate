import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildWebAudienceKey,
  getPublicConversationArtifactDownload,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

import {
  getPublicChatCookieName,
  readPublicChatSessionState,
} from "../../../../public-chat";

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

  const cookieStore = await cookies();
  const session = readPublicChatSessionState({
    representativeSlug: slug,
    cookieValue: cookieStore.get(getPublicChatCookieName(slug))?.value,
  });
  const artifact = await getPublicConversationArtifactDownload({
    representativeSlug: slug,
    artifactId,
    audienceKey: buildWebAudienceKey(session.audienceId),
  });
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  const inline = new URL(request.url).searchParams.get("inline") === "1";
  return new NextResponse(new Uint8Array(artifact.buffer), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": artifact.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${artifact.fileName}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
