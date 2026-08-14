import { NextResponse } from "next/server";

import {
  PublicMaterialAccessError,
  resolveGovernedPublicMaterialDownload,
} from "@delegate/web-data";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; assetId: string }> },
) {
  const { slug, assetId } = await params;
  const token = new URL(request.url).searchParams.get("token")?.trim();
  if (!token) {
    return privateError("Public material token is required.", 403);
  }
  try {
    const material = await resolveGovernedPublicMaterialDownload({
      representativeSlug: slug,
      assetId,
      token,
    });
    if (material.kind === "redirect") {
      const response = NextResponse.redirect(material.url, 307);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Delegate-Material-Version", String(material.processingVersion));
      return response;
    }
    return new NextResponse(Buffer.from(material.bytes), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": material.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "X-Delegate-Material-Version": String(material.processingVersion),
      },
    });
  } catch (error) {
    if (error instanceof PublicMaterialAccessError) {
      return privateError(error.message, error.statusCode);
    }
    console.error("Failed to deliver governed public material.", error);
    return privateError("Public material is temporarily unavailable.", 503);
  }
}

function privateError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}
