import { NextResponse } from "next/server";

import { ChannelManagementError } from "@delegate/web-data";

import { dashboardAuthErrorResponse } from "../auth";

export function channelManagementErrorResponse(
  error: unknown,
  fallbackMessage: string,
) {
  const authResponse = dashboardAuthErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof ChannelManagementError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
