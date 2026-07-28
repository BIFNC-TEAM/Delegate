import { NextResponse } from "next/server";

import {
  ChannelManagementError,
  TelegramBotConnectionError,
} from "@delegate/web-data";

import { dashboardAuthErrorResponse } from "../auth";

export function channelManagementErrorResponse(
  error: unknown,
  fallbackMessage: string,
) {
  const authResponse = dashboardAuthErrorResponse(error);
  if (authResponse) return authResponse;
  if (
    error instanceof ChannelManagementError
    || error instanceof TelegramBotConnectionError
  ) {
    return NextResponse.json(
      { error: error.message },
      {
        status: error.statusCode,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  return NextResponse.json(
    { error: fallbackMessage },
    {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
