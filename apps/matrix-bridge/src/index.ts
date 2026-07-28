import "dotenv/config";

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  activateVerifiedMatrixDirectConversation,
  checkMatrixRuntimePersistenceReadiness,
  clearMatrixRoomRemoteValidationFailures,
  getMatrixRoomSecuritySnapshot,
  getMatrixVirtualUserBinding,
  ingestMatrixApplicationServiceTransaction,
  isolateMatrixConversationRoom,
  matrixServerNameFromUserId,
  normalizeMatrixUserId,
  recordMatrixRoomRemoteValidationFailure,
  recordMatrixRuntimeHealth,
  withActiveMatrixRepresentativeChannelFence,
  type MatrixApplicationServiceEvent,
} from "@delegate/web-data";

import { resolveMatrixBridgeConfig } from "./config";

const config = resolveMatrixBridgeConfig();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://matrix-bridge.local");
    if (
      (request.method === "GET" || request.method === "HEAD")
      && url.pathname === "/health"
    ) {
      return json(response, 200, request.method === "HEAD" ? undefined : { status: "ok", service: "matrix-bridge" });
    }
    if (
      (request.method === "GET" || request.method === "HEAD")
      && url.pathname === "/ready"
    ) {
      const readiness = await getCachedMatrixBridgeReadiness();
      return json(
        response,
        readiness.ready ? 200 : 503,
        request.method === "HEAD"
          ? undefined
          : readiness.ready
            ? { status: "ready", service: "matrix-bridge" }
            : {
                status: "not_ready",
                service: "matrix-bridge",
                reason: readiness.reason,
              },
      );
    }

    if (!isHomeserverAuthorized(request)) {
      return json(response, 403, { errcode: "M_FORBIDDEN", error: "Invalid Matrix homeserver token." });
    }

    const transactionMatch = url.pathname.match(/^\/_matrix\/app\/v1\/transactions\/([^/]+)$/);
    if (request.method === "PUT" && transactionMatch?.[1]) {
      const body = await readJsonBody(request);
      const events = Array.isArray(body.events)
        ? body.events.filter(isMatrixEvent)
        : [];
      const transactionId = decodeURIComponent(transactionMatch[1]);
      const outcome = await processMatrixApplicationServiceTransaction({
        transactionId,
        events,
      });
      if (outcome === "security_retry") {
        return json(response, 503, {
          errcode: "M_UNKNOWN",
          error: "Matrix transaction contains retryable security events.",
          retry_after_ms: 2_000,
        });
      }
      if (outcome === "validation_retry") {
        return json(response, 503, {
          errcode: "M_UNKNOWN",
          error: "Matrix room validation is temporarily unavailable.",
          retry_after_ms: 2_000,
        });
      }
      if (outcome === "content_retry") {
        return json(response, 503, {
          errcode: "M_UNKNOWN",
          error: "Matrix transaction was persisted but contains retryable events.",
          retry_after_ms: 2_000,
        });
      }
      if (outcome === "join_retry") {
        return json(response, 503, {
          errcode: "M_UNKNOWN",
          error: "Managed Matrix users could not join all provisioned rooms.",
          retry_after_ms: 2_000,
        });
      }
      return json(response, 200, {});
    }

    const userMatch = url.pathname.match(/^\/_matrix\/app\/v1\/users\/(.+)$/);
    if (request.method === "GET" && userMatch?.[1]) {
      const binding = await getMatrixVirtualUserBinding(decodeURIComponent(userMatch[1]));
      if (!binding) {
        return json(response, 404, {
          errcode: "M_NOT_FOUND",
          error: "Virtual user is not registered.",
        });
      }
      const registrationError = await ensureMatrixVirtualUserRegistered(
        binding.matrixUserId,
      );
      await recordManagedMatrixRuntimeHealth(
        binding.matrixUserId,
        registrationError
          ? { status: "DEGRADED", errorCode: registrationError }
          : { status: "HEALTHY" },
      );
      return registrationError
        ? json(response, 503, {
            errcode: "M_UNKNOWN",
            error: "Virtual user registration is temporarily unavailable.",
          })
        : json(response, 200, {});
    }

    if (request.method === "POST" && url.pathname === "/_matrix/app/v1/ping") {
      return json(response, 200, {});
    }

    return json(response, 404, {
      errcode: "M_UNRECOGNIZED",
      error: "Route not found.",
    });
  } catch (error) {
    console.error("matrix-bridge request failed", error);
    if (error instanceof MatrixBridgeRequestError) {
      return json(response, error.statusCode, {
        errcode: error.errcode,
        error: error.message,
      });
    }
    return json(response, 500, {
      errcode: "M_UNKNOWN",
      error: "Matrix bridge request failed.",
    });
  }
});

export async function checkMatrixBridgeReadiness(): Promise<
  { ready: true } | { ready: false; reason: string }
> {
  if (!await checkMatrixRuntimePersistenceReadiness()) {
    return { ready: false, reason: "matrix_persistence_unavailable" };
  }
  try {
    const versionsEndpoint = new URL(
      "/_matrix/client/versions",
      config.homeserverUrl,
    );
    const versionsResponse = await fetch(versionsEndpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!versionsResponse.ok) {
      return { ready: false, reason: "matrix_homeserver_unhealthy" };
    }
  } catch {
    return { ready: false, reason: "matrix_homeserver_unreachable" };
  }

  try {
    const whoamiEndpoint = new URL(
      "/_matrix/client/v3/account/whoami",
      config.homeserverUrl,
    );
    const response = await fetchWithTimeout(whoamiEndpoint);
    if (!response.ok) {
      return {
        ready: false,
        reason: "matrix_application_service_auth_unhealthy",
      };
    }
    const payload: unknown = await response.json().catch(() => null);
    const userId =
      payload && typeof payload === "object" && !Array.isArray(payload)
      && "user_id" in payload && typeof payload.user_id === "string"
        ? payload.user_id
        : "";
    if (
      !userId
      || userId !== `@${config.senderLocalpart}:${config.serverName}`
    ) {
      return {
        ready: false,
        reason: "matrix_application_service_identity_mismatch",
      };
    }
    return { ready: true };
  } catch {
    return {
      ready: false,
      reason: "matrix_application_service_auth_unreachable",
    };
  }
}

type MatrixBridgeReadiness =
  Awaited<ReturnType<typeof checkMatrixBridgeReadiness>>;

const matrixBridgeReadinessCacheTtlMs = 2_000;
let matrixBridgeReadinessCache:
  | { expiresAt: number; value: MatrixBridgeReadiness }
  | null = null;
let matrixBridgeReadinessInFlight:
  Promise<MatrixBridgeReadiness> | null = null;

/**
 * `/ready` is intentionally unauthenticated for container orchestrators.
 * Collapse concurrent probes and briefly cache the three backend checks so
 * an exposed listener cannot amplify arbitrary requests into DB/Synapse load.
 */
async function getCachedMatrixBridgeReadiness(): Promise<
  MatrixBridgeReadiness
> {
  const now = Date.now();
  if (
    matrixBridgeReadinessCache
    && matrixBridgeReadinessCache.expiresAt > now
  ) {
    return matrixBridgeReadinessCache.value;
  }
  if (matrixBridgeReadinessInFlight) {
    return matrixBridgeReadinessInFlight;
  }

  const check = checkMatrixBridgeReadiness().then((value) => {
    matrixBridgeReadinessCache = {
      expiresAt: Date.now() + matrixBridgeReadinessCacheTtlMs,
      value,
    };
    return value;
  });
  matrixBridgeReadinessInFlight = check;
  try {
    return await check;
  } finally {
    if (matrixBridgeReadinessInFlight === check) {
      matrixBridgeReadinessInFlight = null;
    }
  }
}

export async function processMatrixApplicationServiceTransaction(input: {
  transactionId: string;
  events: MatrixApplicationServiceEvent[];
}): Promise<
  | "processed"
  | "security_retry"
  | "validation_retry"
  | "content_retry"
  | "join_retry"
> {
  const securityEvents = input.events.filter(isMatrixRoomSecurityEvent);
  const contentEvents = input.events.filter(
    (event) => !isMatrixRoomSecurityEvent(event),
  );
  // Persist and apply room security state first. A transient validation
  // failure for any content room must never keep a membership/encryption
  // event in this homeserver transaction out of the durable inbox.
  const securityResults =
    await ingestMatrixApplicationServiceTransaction({
      transactionId: input.transactionId,
      events: securityEvents,
    });
  if (securityResults.some((result) => result.status === "failed")) {
    return "security_retry";
  }
  const joinFailures = await joinManagedMatrixInvites(securityEvents);
  if (joinFailures.length) return "join_retry";

  const validationFailures =
    await validateActiveMatrixRoomsBeforeIngest(contentEvents);
  if (validationFailures.length) return "validation_retry";

  const contentResults =
    await ingestMatrixApplicationServiceTransaction({
      transactionId: input.transactionId,
      events: contentEvents,
    });
  if (contentResults.some((result) => result.status === "failed")) {
    return "content_retry";
  }
  return "processed";
}

export async function validateActiveMatrixRoomsBeforeIngest(
  events: MatrixApplicationServiceEvent[],
): Promise<string[]> {
  const failures: string[] = [];
  const remotelyValidatedContentEventTypes = new Set([
    "m.room.message",
    "m.room.redaction",
  ]);
  const securityEventTypes = new Set([
    "m.room.member",
    "m.room.encryption",
  ]);
  const roomIds = new Set<string>();
  const securityEventRoomIds = new Set<string>();
  const eventIdByRoomId = new Map<string, string>();
  for (const event of events) {
    const roomId = event.room_id?.trim();
    const eventType = event.type?.trim();
    if (!roomId || !eventType) continue;
    if (securityEventTypes.has(eventType)) {
      securityEventRoomIds.add(roomId);
    }
    if (remotelyValidatedContentEventTypes.has(eventType)) {
      roomIds.add(roomId);
      const eventId = event.event_id?.trim();
      if (eventId && !eventIdByRoomId.has(roomId)) {
        eventIdByRoomId.set(roomId, eventId);
      }
    }
  }
  // Security state from this same durable transaction must be applied before
  // content admission. Never let a stale remote read prevent membership or
  // encryption events from reaching the inbox.
  for (const roomId of securityEventRoomIds) roomIds.delete(roomId);

  for (const roomId of roomIds) {
    const roomSecurity = await getMatrixRoomSecuritySnapshot(roomId);
    if (!roomSecurity || roomSecurity.securityState !== "ACTIVE") continue;
    const audienceMatrixUserId = roomSecurity.audienceMatrixUserId;
    const representativeMatrixUserId =
      roomSecurity.representativeMatrixUserId;
    if (!audienceMatrixUserId || !representativeMatrixUserId) {
      await isolateMatrixConversationRoom({
        roomId,
        reason: "matrix_remote_room_validation_failed",
      });
      if (representativeMatrixUserId) {
        await recordManagedMatrixRuntimeHealth(
          representativeMatrixUserId,
          {
            status: "DEGRADED",
            errorCode: "matrix_room_identity_missing",
          },
        );
      }
      continue;
    }
    const roomCheck = await validatePlaintextDirectRoom({
      roomId,
      audienceMatrixUserId,
      representativeMatrixUserId,
    });
    if (roomCheck.ok) {
      if (roomSecurity.remoteValidationAttemptCount > 0) {
        await clearMatrixRoomRemoteValidationFailures(roomId);
      }
      continue;
    }

    if (roomCheck.retryable) {
      const eventId = eventIdByRoomId.get(roomId);
      const disposition =
        await recordMatrixRoomRemoteValidationFailure({
          roomId,
          errorCode: roomCheck.reason,
          retryable: true,
          expectedSecurityState: "ACTIVE",
          ...(eventId ? { eventId } : {}),
        });
      if (disposition.status !== "ignored") {
        await recordManagedMatrixRuntimeHealth(
          representativeMatrixUserId,
          {
            status: "DEGRADED",
            errorCode: roomCheck.reason,
          },
        );
      }
      if (disposition.status === "retry_scheduled") {
        failures.push(`${roomId}:${roomCheck.reason}`);
      }
      continue;
    }

    if (roomCheck.encrypted) {
      await isolateMatrixConversationRoom({
        roomId,
        reason: "matrix_room_encrypted",
      });
    } else {
      const eventId = eventIdByRoomId.get(roomId);
      await recordMatrixRoomRemoteValidationFailure({
        roomId,
        errorCode: roomCheck.reason,
        retryable: false,
        expectedSecurityState: "ACTIVE",
        ...(eventId ? { eventId } : {}),
      });
    }
    await recordManagedMatrixRuntimeHealth(
      representativeMatrixUserId,
      {
        status: "DEGRADED",
        errorCode: roomCheck.reason,
      },
    );
  }
  return failures;
}

export async function joinManagedMatrixInvites(
  events: MatrixApplicationServiceEvent[],
): Promise<string[]> {
  const failures: string[] = [];
  const handledInvites = new Set<string>();
  if (!config.homeserverUrl || !config.applicationServiceToken) return failures;

  for (const event of events) {
    if (
      event.type !== "m.room.member"
      || event.content?.membership !== "invite"
      || event.content?.is_direct !== true
      || !event.room_id
      || !event.state_key
      || !event.sender
    ) {
      continue;
    }
    const roomId = event.room_id;
    const inviteKey = `${roomId}\u0000${event.state_key}`;
    if (handledInvites.has(inviteKey)) continue;
    handledInvites.add(inviteKey);
    const binding = await getMatrixVirtualUserBinding(event.state_key);
    if (
      !binding
      || binding.matrixUserId !== event.state_key
      || !binding.representativeId
    ) {
      continue;
    }
    const roomSecurity = await getMatrixRoomSecuritySnapshot(roomId);
    if (!roomSecurity) {
      await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
        status: "DEGRADED",
        errorCode: "matrix_room_security_state_missing",
      });
      failures.push(
        `${roomId}:${binding.matrixUserId}:room_security_state_missing`,
      );
      continue;
    }
    if (roomSecurity.securityState === "ISOLATED") continue;
    if (roomSecurity.securityState === "ACTIVE") {
      await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
        status: "HEALTHY",
      });
      continue;
    }
    if (
      roomSecurity.audienceMatrixUserId !== event.sender
      || roomSecurity.representativeMatrixUserId !== binding.matrixUserId
    ) {
      await isolateMatrixConversationRoom({
        roomId,
        reason: "matrix_remote_room_validation_failed",
      });
      await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
        status: "DEGRADED",
        errorCode: "matrix_room_identity_mismatch",
      });
      continue;
    }
    if (roomSecurity.securityState !== "PENDING_REMOTE_VALIDATION") {
      await isolateMatrixConversationRoom({
        roomId,
        reason: "matrix_remote_room_validation_failed",
      });
      await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
        status: "DEGRADED",
        errorCode: "matrix_room_security_state_invalid",
      });
      continue;
    }

    const remoteJoin = await withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: binding.representativeId,
        representativeMatrixUserId: binding.matrixUserId,
      },
      async () => {
        const registrationError = await ensureMatrixVirtualUserRegistered(
          binding.matrixUserId,
        );
        if (registrationError) {
          return {
            ok: false as const,
            errorCode: registrationError,
            failureDetail: registrationError,
            retryable:
              isRetryableMatrixRemoteErrorCode(registrationError),
          };
        }

        const endpoint = new URL(
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
          config.homeserverUrl,
        );
        endpoint.searchParams.set("user_id", binding.matrixUserId);
        try {
          const join = await fetchWithTimeout(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          if (join.ok) return { ok: true as const };
          return {
            ok: false as const,
            errorCode: `matrix_join_${join.status}`,
            failureDetail: String(join.status),
            retryable: isRetryableMatrixHttpStatus(join.status),
          };
        } catch (error) {
          const timeout =
            error instanceof Error && error.name === "AbortError";
          return {
            ok: false as const,
            errorCode: timeout
              ? "matrix_join_timeout"
              : "matrix_join_failed",
            failureDetail: timeout ? "join_timeout" : "join_failed",
            retryable: true,
          };
        }
      },
    );
    if (!remoteJoin.executed) {
      continue;
    }
    if (!remoteJoin.value.ok) {
      const disposition =
        await recordMatrixRoomRemoteValidationFailure({
          roomId,
          errorCode: remoteJoin.value.errorCode,
          retryable: remoteJoin.value.retryable,
          expectedSecurityState: "PENDING_REMOTE_VALIDATION",
          ...(event.event_id?.trim()
            ? { eventId: event.event_id.trim() }
            : {}),
        });
      if (disposition.status !== "ignored") {
        await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
          status: "DEGRADED",
          errorCode: remoteJoin.value.errorCode,
        });
      }
      if (disposition.status === "retry_scheduled") {
        failures.push(
          `${roomId}:${binding.matrixUserId}:`
          + remoteJoin.value.failureDetail,
        );
      }
      continue;
    }

    const roomCheck = await validatePlaintextDirectRoom({
      roomId,
      audienceMatrixUserId: event.sender,
      representativeMatrixUserId: binding.matrixUserId,
    });
    if (!roomCheck.ok) {
      const leaveError = await leaveManagedMatrixRoom(
        roomId,
        binding.matrixUserId,
      );
      let disposition: { status: "isolated" | "retry_scheduled" | "ignored" };
      if (roomCheck.encrypted) {
        await isolateMatrixConversationRoom({
          roomId,
          reason: "matrix_room_encrypted",
        });
        disposition = { status: "isolated" };
      } else {
        disposition = await recordMatrixRoomRemoteValidationFailure({
          roomId,
          errorCode: roomCheck.reason,
          retryable: roomCheck.retryable,
          expectedSecurityState: "PENDING_REMOTE_VALIDATION",
          ...(event.event_id?.trim()
            ? { eventId: event.event_id.trim() }
            : {}),
        });
      }
      if (disposition.status !== "ignored") {
        await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
          status: "DEGRADED",
          errorCode: roomCheck.reason,
        });
      }
      if (disposition.status === "retry_scheduled") {
        failures.push(
          `${roomId}:${binding.matrixUserId}:${roomCheck.reason}`
          + (leaveError ? `:${leaveError}` : ""),
        );
      }
      continue;
    }
    const activated = await activateVerifiedMatrixDirectConversation({
      roomId,
      audienceMatrixUserId: event.sender,
      representativeMatrixUserId: binding.matrixUserId,
    });
    if (!activated) {
      const currentSecurity = await getMatrixRoomSecuritySnapshot(roomId);
      if (
        currentSecurity?.securityState === "ACTIVE"
        && currentSecurity.audienceMatrixUserId === event.sender
        && currentSecurity.representativeMatrixUserId === binding.matrixUserId
      ) {
        await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
          status: "HEALTHY",
        });
        if (roomSecurity.remoteValidationAttemptCount > 0) {
          await clearMatrixRoomRemoteValidationFailures(roomId);
        }
        continue;
      }
      if (
        !currentSecurity
        || currentSecurity.securityState === "ISOLATED"
        || currentSecurity.representativeChannelDesiredState !== "ACTIVE"
      ) {
        // Disconnect, pause, deletion, or a concurrent security event won the
        // race after the remote join. Leave best-effort without replacing the
        // winning terminal/control-plane state with a generic isolation.
        await leaveManagedMatrixRoom(roomId, binding.matrixUserId);
        continue;
      }
      await isolateMatrixConversationRoom({
        roomId,
        reason: "matrix_remote_room_validation_failed",
      });
      await leaveManagedMatrixRoom(
        roomId,
        binding.matrixUserId,
      );
      await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
        status: "DEGRADED",
        errorCode: "matrix_room_activation_failed",
      });
    } else {
      await recordManagedMatrixRuntimeHealth(binding.matrixUserId, {
        status: "HEALTHY",
      });
      if (roomSecurity.remoteValidationAttemptCount > 0) {
        await clearMatrixRoomRemoteValidationFailures(roomId);
      }
    }
  }
  return failures;
}

async function recordManagedMatrixRuntimeHealth(
  matrixUserId: string,
  input:
    | { status: "HEALTHY"; errorCode?: never }
    | { status: "DEGRADED" | "UNHEALTHY"; errorCode: string },
) {
  try {
    const errorCode =
      input.status === "HEALTHY"
        ? undefined
        : input.errorCode.startsWith("matrix_")
          ? input.errorCode
          : `matrix_runtime_${input.errorCode}`;
    await recordMatrixRuntimeHealth({
      matrixUserId,
      status: input.status,
      ...(errorCode ? { errorCode } : {}),
    });
  } catch (error) {
    console.error(
      "matrix-bridge could not persist runtime health",
      error instanceof Error ? error.name : "unknown_error",
    );
  }
}

export async function ensureMatrixVirtualUserRegistered(
  matrixUserId: string,
): Promise<string | null> {
  if (
    !config.homeserverUrl
    || !config.applicationServiceToken
    || !config.serverName
  ) {
    return "virtual_user_registration_unavailable";
  }
  let normalizedMatrixUserId: string;
  try {
    normalizedMatrixUserId = normalizeMatrixUserId(matrixUserId);
  } catch {
    return "virtual_user_id_invalid";
  }
  const match = normalizedMatrixUserId.match(/^@([^:]+):(.+)$/);
  if (!match?.[1] || !match[2]) return "virtual_user_id_invalid";
  const [, localpart] = match;
  if (matrixServerNameFromUserId(normalizedMatrixUserId) !== config.serverName) {
    return "virtual_user_server_mismatch";
  }

  const endpoint = new URL(
    "/_matrix/client/v3/register",
    config.homeserverUrl,
  );
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.application_service",
        username: localpart,
        inhibit_login: true,
      }),
    });
    if (response.ok) return null;

    const payload = await response.json().catch(() => ({})) as {
      errcode?: string;
    };
    return response.status === 400 && payload.errcode === "M_USER_IN_USE"
      ? null
      : `register_${response.status}`;
  } catch (error) {
    return error instanceof Error && error.name === "AbortError"
      ? "register_timeout"
      : "register_failed";
  }
}

async function leaveManagedMatrixRoom(
  roomId: string,
  matrixUserId: string,
): Promise<string | null> {
  const endpoint = matrixClientEndpoint(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
    matrixUserId,
  );
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok ? null : `leave_${response.status}`;
  } catch {
    return "leave_failed";
  }
}

/**
 * The invite flag is not sufficient proof of a safe Matrix DM. Once the AS
 * user has joined, ask the homeserver for the authoritative current members
 * and encryption state. Any timeout, inaccessible state, third member, or
 * encryption is a fail-closed condition.
 */
async function validatePlaintextDirectRoom(input: {
  roomId: string;
  audienceMatrixUserId: string;
  representativeMatrixUserId: string;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      encrypted: boolean;
      reason: string;
      retryable: boolean;
    }
> {
  if (!config.homeserverUrl || !config.applicationServiceToken) {
    return {
      ok: false,
      encrypted: false,
      reason: "homeserver_validation_unavailable",
      retryable: true,
    };
  }
  try {
    const membersEndpoint = matrixClientEndpoint(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/joined_members`,
      input.representativeMatrixUserId,
    );
    const membersResponse = await fetchWithTimeout(membersEndpoint);
    if (!membersResponse.ok) {
      return {
        ok: false,
        encrypted: false,
        reason: `joined_members_${membersResponse.status}`,
        retryable: isRetryableMatrixHttpStatus(membersResponse.status),
      };
    }
    const membersPayload: unknown = await membersResponse.json();
    const members = membersPayload && typeof membersPayload === "object" && !Array.isArray(membersPayload)
      && "joined" in membersPayload
      && membersPayload.joined && typeof membersPayload.joined === "object"
      && !Array.isArray(membersPayload.joined)
      ? Object.keys(membersPayload.joined)
      : [];
    const expected = new Set([input.audienceMatrixUserId, input.representativeMatrixUserId]);
    if (members.length !== expected.size || members.some((member) => !expected.has(member))) {
      return {
        ok: false,
        encrypted: false,
        reason: "joined_members_not_exactly_direct",
        retryable: false,
      };
    }

    const encryptionEndpoint = matrixClientEndpoint(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/state/m.room.encryption/`,
      input.representativeMatrixUserId,
    );
    const encryptionResponse = await fetchWithTimeout(encryptionEndpoint);
    if (encryptionResponse.ok) {
      return {
        ok: false,
        encrypted: true,
        reason: "room_encryption_enabled",
        retryable: false,
      };
    }
    if (encryptionResponse.status !== 404) {
      return {
        ok: false,
        encrypted: false,
        reason: `room_encryption_state_${encryptionResponse.status}`,
        retryable: isRetryableMatrixHttpStatus(encryptionResponse.status),
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      encrypted: false,
      reason: error instanceof Error && error.name === "AbortError"
        ? "homeserver_validation_timeout"
        : "homeserver_validation_failed",
      retryable: true,
    };
  }
}

function isRetryableMatrixHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableMatrixRemoteErrorCode(errorCode: string): boolean {
  if (
    errorCode.endsWith("_timeout")
    || errorCode.endsWith("_failed")
    || errorCode.endsWith("_unavailable")
  ) {
    return true;
  }
  const statusMatch = errorCode.match(/_(\d{3})$/);
  return statusMatch?.[1]
    ? isRetryableMatrixHttpStatus(Number(statusMatch[1]))
    : false;
}

function matrixClientEndpoint(path: string, userId: string): URL {
  const endpoint = new URL(path, config.homeserverUrl);
  endpoint.searchParams.set("user_id", userId);
  return endpoint;
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.applicationServiceToken}`);
  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`matrix-bridge listening on http://0.0.0.0:${config.port}`);
  });
}

function isHomeserverAuthorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const authorizationToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
  const queryToken = new URL(
    request.url || "/",
    "http://matrix-bridge.local",
  ).searchParams.get("access_token")?.trim();
  if (
    authorizationToken
    && queryToken
    && !safeTokenEquals(authorizationToken, queryToken)
  ) {
    return false;
  }
  const token = authorizationToken || queryToken;
  if (!token) return false;

  return safeTokenEquals(config.homeserverToken, token);
}

function safeTokenEquals(expectedToken: string, receivedToken: string) {
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(receivedToken);
  return expected.length === received.length
    && timingSafeEqual(expected, received);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > config.maxBodyBytes) {
      throw new MatrixBridgeRequestError(
        413,
        "M_TOO_LARGE",
        "Matrix transaction body is too large.",
      );
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MatrixBridgeRequestError(
      400,
      "M_BAD_JSON",
      "Matrix transaction body must be valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MatrixBridgeRequestError(
      400,
      "M_BAD_JSON",
      "Matrix transaction body must be a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}

function isMatrixEvent(value: unknown): value is MatrixApplicationServiceEvent {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMatrixRoomSecurityEvent(
  event: MatrixApplicationServiceEvent,
): boolean {
  const eventType = event.type?.trim();
  return eventType === "m.room.member"
    || eventType === "m.room.encryption";
}

function json(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(payload === undefined ? undefined : JSON.stringify(payload));
}

class MatrixBridgeRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 413,
    readonly errcode: "M_BAD_JSON" | "M_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "MatrixBridgeRequestError";
  }
}
