import { NextResponse } from "next/server";
import { getPublicRepresentativeRuntime } from "@delegate/web-data";
import { getGovernedContextDisclosure } from "../governed-context-disclosure";

/** The same published/public gate as the Web page, with an explicit field allowlist. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") {
      return NextResponse.json(
        { error: "Representative is not publicly available." },
        {
          status: runtime.status === "paused" ? 423 : 404,
          headers,
        },
      );
    }
    const locale =
      new URL(request.url).searchParams.get("lang") === "en" ? "en" : "zh";
    return NextResponse.json(
      {
        schemaVersion: 1,
        representative: {
          slug,
          name: runtime.setup.name,
          ownerName: runtime.setup.ownerName,
          tagline: runtime.setup.tagline,
        },
        memoryDisclosure: {
          policyRevision: runtime.governedMemoryDisclosure.policyRevision,
          fingerprint: runtime.governedMemoryDisclosure.fingerprint,
        },
        disclosureText: getGovernedContextDisclosure(
          locale,
          runtime.governedMemoryDisclosure,
        ),
      },
      { headers },
    );
  } catch {
    return NextResponse.json(
      { error: "Representative profile is temporarily unavailable." },
      { status: 503, headers },
    );
  }
}
