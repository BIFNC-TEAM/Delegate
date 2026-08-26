import { NextResponse } from "next/server";

import {
  LOGTO_WEBHOOK_SIGNATURE_HEADER,
  LogtoWebhookError,
  processLogtoLifecycleWebhook,
} from "@delegate/web-data";

export function GET() {
  return new Response(null, {
    status: 405,
    headers: {
      allow: "POST",
      "cache-control": "no-store",
    },
  });
}

export const HEAD = GET;

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const result = await processLogtoLifecycleWebhook({
      rawBody,
      signature: request.headers.get(LOGTO_WEBHOOK_SIGNATURE_HEADER),
    });
    return NextResponse.json(
      { received: true, status: result.status },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof LogtoWebhookError) {
      return NextResponse.json(
        { received: false, error: error.code },
        {
          status: error.statusCode,
          headers: { "cache-control": "no-store" },
        },
      );
    }
    return NextResponse.json(
      { received: false, error: "LIFECYCLE_PROCESSING_UNAVAILABLE" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
