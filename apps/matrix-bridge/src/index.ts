import "dotenv/config";

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  activateVerifiedMatrixDirectConversation,
  getMatrixRoomSecuritySnapshot,
  getMatrixVirtualUserBinding,
  ingestMatrixApplicationServiceTransaction,
  isolateMatrixConversationRoom,
  type MatrixApplicationServiceEvent,
} from "@delegate/web-data";

import { resolveMatrixBridgeConfig } from "./config";

const config = resolveMatrixBridgeConfig();

const server = createServer(async (request, response) => {
  try {
    if ((request.method === "GET" || request.method === "HEAD") && request.url === "/health") {
      return json(response, 200, request.method === "HEAD" ? undefined : { status: "ok", service: "matrix-bridge" });
    }

    if (!isHomeserverAuthorized(request)) {
      return json(response, 403, { errcode: "M_FORBIDDEN", error: "Invalid Matrix homeserver token." });
    }

    const url = new URL(request.url || "/", "http://matrix-bridge.local");
    const transactionMatch = url.pathname.match(/^\/_matrix\/app\/v1\/transactions\/([^/]+)$/);
    if (request.method === "PUT" && transactionMatch?.[1]) {
      const body = await readJsonBody(request);
      const events = Array.isArray(body.events)
        ? body.events.filter(isMatrixEvent)
        : [];
      const results = await ingestMatrixApplicationServiceTransaction({
        transactionId: decodeURIComponent(transactionMatch[1]),
        events,
      });
      const joinFailures = await joinManagedMatrixInvites(events);
      if (results.some((result) => result.status === "failed")) {
        return json(response, 503, {
          errcode: "M_UNKNOWN",
          error: "Matrix transaction was persisted but contains retryable events.",
          retry_after_ms: 2_000,
        });
      }
      if (joinFailures.length) {
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

    return json(response, 404, { errcode: "M_NOT_FOUND", error: "Route not found." });
  } catch (error) {
    console.error("matrix-bridge request failed", error);
    return json(response, 500, {
      errcode: "M_UNKNOWN",
      error: error instanceof Error ? error.message : "Matrix bridge request failed.",
    });
  }
});

export async function joinManagedMatrixInvites(
  events: MatrixApplicationServiceEvent[],
): Promise<string[]> {
  const failures: string[] = [];
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
    const binding = await getMatrixVirtualUserBinding(event.state_key);
    if (!binding || binding.matrixUserId !== event.state_key) continue;
    const roomSecurity = await getMatrixRoomSecuritySnapshot(event.room_id);
    if (!roomSecurity) {
      failures.push(
        `${event.room_id}:${binding.matrixUserId}:room_security_state_missing`,
      );
      continue;
    }
    if (roomSecurity.securityState === "ISOLATED") continue;
    if (
      roomSecurity.audienceMatrixUserId !== event.sender
      || roomSecurity.representativeMatrixUserId !== binding.matrixUserId
    ) {
      await isolateMatrixConversationRoom({
        roomId: event.room_id,
        reason: "matrix_remote_room_validation_failed",
      });
      continue;
    }
    if (roomSecurity.securityState === "ACTIVE") continue;
    if (roomSecurity.securityState !== "PENDING_REMOTE_VALIDATION") {
      await isolateMatrixConversationRoom({
        roomId: event.room_id,
        reason: "matrix_remote_room_validation_failed",
      });
      continue;
    }

    const registrationError = await ensureMatrixVirtualUserRegistered(
      binding.matrixUserId,
    );
    if (registrationError) {
      failures.push(
        `${event.room_id}:${binding.matrixUserId}:${registrationError}`,
      );
      continue;
    }

    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(event.room_id)}/join`,
      config.homeserverUrl,
    );
    endpoint.searchParams.set("user_id", binding.matrixUserId);
    const join = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!join.ok) {
      failures.push(`${event.room_id}:${binding.matrixUserId}:${join.status}`);
      continue;
    }

    const roomCheck = await validatePlaintextDirectRoom({
      roomId: event.room_id,
      audienceMatrixUserId: event.sender,
      representativeMatrixUserId: binding.matrixUserId,
    });
    if (!roomCheck.ok) {
      await isolateMatrixConversationRoom({
        roomId: event.room_id,
        reason: roomCheck.encrypted
          ? "matrix_room_encrypted"
          : "matrix_remote_room_validation_failed",
      });
      const leaveError = await leaveManagedMatrixRoom(
        event.room_id,
        binding.matrixUserId,
      );
      failures.push(
        `${event.room_id}:${binding.matrixUserId}:${roomCheck.reason}`
        + (leaveError ? `:${leaveError}` : ""),
      );
      continue;
    }
    const activated = await activateVerifiedMatrixDirectConversation({
      roomId: event.room_id,
      audienceMatrixUserId: event.sender,
      representativeMatrixUserId: binding.matrixUserId,
    });
    if (!activated) {
      const currentSecurity = await getMatrixRoomSecuritySnapshot(event.room_id);
      if (
        currentSecurity?.securityState === "ACTIVE"
        && currentSecurity.audienceMatrixUserId === event.sender
        && currentSecurity.representativeMatrixUserId === binding.matrixUserId
      ) {
        continue;
      }
      await isolateMatrixConversationRoom({
        roomId: event.room_id,
        reason: "matrix_remote_room_validation_failed",
      });
      const leaveError = await leaveManagedMatrixRoom(
        event.room_id,
        binding.matrixUserId,
      );
      failures.push(
        `${event.room_id}:${binding.matrixUserId}:room_activation_failed`
        + (leaveError ? `:${leaveError}` : ""),
      );
    }
  }
  return failures;
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
  const match = matrixUserId.match(/^@([^:]+):(.+)$/);
  if (!match?.[1] || !match[2]) return "virtual_user_id_invalid";
  const [, localpart, serverName] = match;
  if (serverName.toLowerCase() !== config.serverName) {
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
}): Promise<{ ok: true } | { ok: false; encrypted: boolean; reason: string }> {
  if (!config.homeserverUrl || !config.applicationServiceToken) {
    return { ok: false, encrypted: false, reason: "homeserver_validation_unavailable" };
  }
  try {
    const membersEndpoint = matrixClientEndpoint(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/joined_members`,
      input.representativeMatrixUserId,
    );
    const membersResponse = await fetchWithTimeout(membersEndpoint);
    if (!membersResponse.ok) {
      return { ok: false, encrypted: false, reason: `joined_members_${membersResponse.status}` };
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
      return { ok: false, encrypted: false, reason: "joined_members_not_exactly_direct" };
    }

    const encryptionEndpoint = matrixClientEndpoint(
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/state/m.room.encryption/`,
      input.representativeMatrixUserId,
    );
    const encryptionResponse = await fetchWithTimeout(encryptionEndpoint);
    if (encryptionResponse.ok) {
      return { ok: false, encrypted: true, reason: "room_encryption_enabled" };
    }
    if (encryptionResponse.status !== 404) {
      return { ok: false, encrypted: false, reason: `room_encryption_state_${encryptionResponse.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      encrypted: false,
      reason: error instanceof Error && error.name === "AbortError"
        ? "homeserver_validation_timeout"
        : "homeserver_validation_failed",
    };
  }
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
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : new URL(request.url || "/", "http://matrix-bridge.local").searchParams.get("access_token")?.trim();
  if (!token) return false;

  const expected = Buffer.from(config.homeserverToken);
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > config.maxBodyBytes) throw new Error("Matrix transaction body is too large.");
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Matrix transaction body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function isMatrixEvent(value: unknown): value is MatrixApplicationServiceEvent {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(payload === undefined ? undefined : JSON.stringify(payload));
}
