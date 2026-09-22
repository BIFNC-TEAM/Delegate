import { NextResponse } from "next/server";
import { AvatarUploadError, readOwnerAvatarObject } from "@delegate/web-data/owner-avatar-storage";

// Avatar display URLs use an opaque random object identifier. COS stays private;
// this route serves only the avatars namespace, never arbitrary storage keys/URLs.
export async function GET(_request: Request, { params }: { params: Promise<{ owner: string; id: string }> }) {
  try {
    const { owner, id } = await params;
    const bytes = await readOwnerAvatarObject(owner, id);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      "Content-Type": "image/jpeg", "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer",
    } });
  } catch (error) {
    return NextResponse.json({ error: "Avatar unavailable." }, { status: error instanceof AvatarUploadError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
