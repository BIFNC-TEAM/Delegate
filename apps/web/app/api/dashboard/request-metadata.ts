import { randomUUID } from "node:crypto";

const safeRequestToken = /^[A-Za-z0-9._:-]{1,191}$/;

export function resolveDashboardRequestMetadata(request: Request) {
  const suppliedRequestId = request.headers.get("x-request-id")?.trim() ?? "";
  const requestId = safeRequestToken.test(suppliedRequestId)
    ? suppliedRequestId
    : randomUUID();
  const suppliedIdempotencyKey =
    request.headers.get("idempotency-key")?.trim() ?? "";
  const idempotencyKey = safeRequestToken.test(suppliedIdempotencyKey)
    ? suppliedIdempotencyKey
    : requestId;
  return { requestId, idempotencyKey };
}
