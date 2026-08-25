import { NextResponse } from "next/server";

import { getOwnerConversationAttachmentDownload } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../../auth";

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      slug: string;
      conversationId: string;
      attachmentId: string;
    }>;
  },
) {
  const { slug, conversationId, attachmentId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const attachment = await getOwnerConversationAttachmentDownload({
      representativeSlug: slug,
      conversationId,
      attachmentId,
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
    });
    if (!attachment) {
      return NextResponse.json(
        { error: "Conversation attachment not found." },
        { status: 404 },
      );
    }
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    const asciiFileName = attachment.fileName
      .replace(/[^\x20-\x7E]/gu, "_")
      .replace(/["\\]/gu, "_");
    return new NextResponse(new Uint8Array(attachment.buffer), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": attachment.mimeType,
        "Content-Disposition":
          `${inline ? "inline" : "attachment"}; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : "Failed to download conversation attachment.",
      },
      { status: 500 },
    );
  }
}
