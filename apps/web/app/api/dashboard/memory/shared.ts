import { NextResponse } from "next/server";
import { z, ZodError } from "zod";

import {
  MemoryGovernanceError,
  RepresentativeAccessError,
} from "@delegate/web-data";
import { MemoryDashboardError } from "@delegate/web-data/memory-dashboard";

import { withPrivateNoStore } from "../../private-response";
import { requireDashboardApiOwnerSession } from "../auth";
import { resolveDashboardRequestMetadata } from "../request-metadata";

const safeRequestToken = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u;

class MemoryRouteInputError extends Error {
  constructor(
    readonly code: "memory_dashboard_invalid_query" | "memory_dashboard_idempotency_required",
    message: string,
  ) {
    super(message);
    this.name = "MemoryRouteInputError";
  }
}

export async function requireMemoryDashboardOwnerId() {
  const session = await requireDashboardApiOwnerSession();
  const ownerId = session?.ownerId?.trim();
  if (!ownerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }
  return ownerId;
}

export function parseMemoryDashboardQuery<T>(
  request: Request,
  schema: z.ZodType<T>,
) {
  const params = new URL(request.url).searchParams;
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) {
      throw new MemoryRouteInputError(
        "memory_dashboard_invalid_query",
        `Query parameter ${key} must not be repeated.`,
      );
    }
    values[key] = value;
  }
  return schema.parse(values);
}

export function requireMemoryDashboardWriteMetadata(request: Request) {
  const suppliedIdempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!safeRequestToken.test(suppliedIdempotencyKey)) {
    throw new MemoryRouteInputError(
      "memory_dashboard_idempotency_required",
      "A valid Idempotency-Key header is required.",
    );
  }
  const metadata = resolveDashboardRequestMetadata(request);
  return {
    requestId: metadata.requestId,
    idempotencyKey: suppliedIdempotencyKey,
  };
}

export function memoryDashboardJson(body: unknown, status = 200) {
  return withPrivateNoStore(NextResponse.json(body, { status }));
}

export function memoryDashboardErrorResponse(error: unknown) {
  if (error instanceof MemoryRouteInputError) {
    return memoryDashboardJson({ error: error.message, code: error.code }, 422);
  }
  if (error instanceof ZodError) {
    return memoryDashboardJson({
      error: "Invalid memory system request.",
      code: "memory_dashboard_invalid_request",
      issues: error.issues.map((issue) => {
        const reasonCode = "params" in issue
          && issue.params
          && typeof issue.params === "object"
          && "reasonCode" in issue.params
          && typeof issue.params.reasonCode === "string"
          ? issue.params.reasonCode
          : null;
        return {
          path: issue.path.join("."),
          message: issue.message,
          ...(reasonCode ? { reasonCode } : {}),
        };
      }),
    }, 422);
  }
  if (error instanceof RepresentativeAccessError) {
    const status = error.statusCode === 401 ? 401 : 404;
    return memoryDashboardJson({
      error: status === 401 ? "Authentication required." : "Memory workspace not found.",
      code: status === 401
        ? "memory_dashboard_unauthorized"
        : "memory_dashboard_not_found",
    }, status);
  }
  if (error instanceof MemoryDashboardError) {
    return memoryDashboardJson({ error: error.message, code: error.code }, error.statusCode);
  }
  if (error instanceof MemoryGovernanceError) {
    if (error.code === "memory_not_found" || error.code === "memory_forbidden") {
      return memoryDashboardJson({
        error: "Memory workspace item not found.",
        code: "memory_dashboard_not_found",
      }, 404);
    }
    return memoryDashboardJson({ error: error.message, code: error.code }, error.statusCode);
  }
  return memoryDashboardJson({
    error: "The memory system request could not be completed.",
    code: "memory_dashboard_internal_error",
  }, 500);
}
