import type { PlanTier } from "@delegate/domain";
import type { ModelRuntimeRecentTurn } from "@delegate/model-runtime";
import type { PublicGovernedMemoryDisclosure } from "@delegate/web-data";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  isLoopbackRepresentativeHostname,
  resolveRepresentativePublicBaseUrl,
} from "./public-auth";

export type PublicChatRequest = {
  message: string;
  clientMessageId?: string;
  memoryDisclosure: PublicMemoryDisclosureProof | null;
};

export type PublicMemoryDisclosureProof = Pick<
  PublicGovernedMemoryDisclosure,
  "policyRevision" | "fingerprint"
>;

export type PublicChatResponse = {
  reply: {
    role: "assistant";
    text: string;
  };
  plan: {
    intent: string;
    nextStep: string;
    suggestedPlan?: PlanTier;
    reasons: string[];
  };
  tier: PlanTier;
  usage: {
    freeRepliesUsed: number;
    freeRepliesRemaining: number;
    serviceCreditsAvailable: number;
    serviceCreditsReserved: number;
    passUnlocked: boolean;
    deepHelpUnlocked: boolean;
  };
  runtime: {
    usedModel: boolean;
    runId?: string;
    provider?: "openai" | "anthropic";
    model?: string;
    fallbackReason?: string;
  };
};

export type PublicChatSessionState = {
  audienceId: string;
  sessionToken: string;
  expiresAt: string;
};

type PublicChatSessionCookiePayload = {
  version: 2;
  representativeSlug: string;
  audienceId: string;
  sessionToken: string;
  expiresAt: string;
};

const PUBLIC_CHAT_STATE_VERSION = 2 as const;
const PUBLIC_CHAT_COOKIE_PREFIX = "delegate-public-chat";
const PUBLIC_CHAT_AUDIENCE_ID_PREFIX = "aud";
const PUBLIC_CHAT_RECENT_TURN_LIMIT = 8;
const PUBLIC_CHAT_TURN_TEXT_LIMIT = 240;
const PUBLIC_MEMORY_DISCLOSURE_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const PUBLIC_CHAT_EFFECTIVE_TIER: PlanTier = "free";
export const PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function normalizePublicChatRequest(payload: unknown): PublicChatRequest {
  const body = (payload ?? {}) as Record<string, unknown>;
  const message =
    typeof body.message === "string" ? body.message.trim() : "";
  const clientMessageId =
    typeof body.clientMessageId === "string" && body.clientMessageId.trim().length <= 160
      ? body.clientMessageId.trim()
      : undefined;
  const memoryDisclosure = normalizePublicMemoryDisclosureProof(
    body.memoryDisclosure,
  );

  return {
    message,
    ...(clientMessageId ? { clientMessageId } : {}),
    memoryDisclosure,
  };
}

export function publicMemoryDisclosureMatches(
  proof: PublicMemoryDisclosureProof | null,
  current: Pick<
    PublicGovernedMemoryDisclosure,
    "policyRevision" | "fingerprint"
  >,
): boolean {
  if (!proof || proof.policyRevision !== current.policyRevision) {
    return false;
  }

  const expected = Buffer.from(current.fingerprint, "utf8");
  const actual = Buffer.from(proof.fingerprint, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizePublicMemoryDisclosureProof(
  value: unknown,
): PublicMemoryDisclosureProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const policyRevision = candidate.policyRevision;
  const fingerprint = candidate.fingerprint;
  const hasValidRevision = policyRevision === null || (
    typeof policyRevision === "number"
    && Number.isInteger(policyRevision)
    && policyRevision >= 0
  );

  if (
    !hasValidRevision
    || typeof fingerprint !== "string"
    || !PUBLIC_MEMORY_DISCLOSURE_FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    return null;
  }

  return { policyRevision, fingerprint };
}

export function deriveTierUsage(params: {
  freeRepliesUsed: number;
  freeReplyLimit: number;
  serviceCreditsAvailable?: number;
  serviceCreditsReserved?: number;
}) {
  const serviceCreditsAvailable = Math.max(
    0,
    Math.trunc(params.serviceCreditsAvailable ?? 0),
  );
  const serviceCreditsReserved = Math.max(
    0,
    Math.trunc(params.serviceCreditsReserved ?? 0),
  );
  return {
    freeRepliesUsed: params.freeRepliesUsed,
    freeRepliesRemaining: Math.max(
      0,
      params.freeReplyLimit - params.freeRepliesUsed,
    ),
    serviceCreditsAvailable,
    serviceCreditsReserved,
    passUnlocked: serviceCreditsAvailable > 0 || serviceCreditsReserved > 0,
    deepHelpUnlocked: false,
  };
}

export function resolvePublicChatTier(
  usage: ReturnType<typeof deriveTierUsage>,
): PlanTier {
  return usage.passUnlocked ? "pass" : "free";
}

export function sanitizeRecentTurns(value: unknown): ModelRuntimeRecentTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const turns: ModelRuntimeRecentTurn[] = [];

  for (const item of value) {
    const turn = item as Record<string, unknown>;
    const direction =
      turn.direction === "inbound" || turn.direction === "outbound"
        ? turn.direction
        : null;
    const messageText =
      typeof turn.messageText === "string" ? turn.messageText.trim() : "";

    if (!direction || !messageText) {
      continue;
    }

    turns.push({
      direction,
      messageText: truncateRecentTurnText(messageText),
      ...(typeof turn.intent === "string" ? { intent: turn.intent } : {}),
      ...(typeof turn.summary === "string"
        ? { summary: truncateRecentTurnText(turn.summary) }
        : {}),
    });
  }

  return turns.slice(-PUBLIC_CHAT_RECENT_TURN_LIMIT);
}

export function getPublicChatCookieName(representativeSlug: string) {
  return `${PUBLIC_CHAT_COOKIE_PREFIX}-${representativeSlug}`;
}

export function shouldUseSecurePublicChatCookie(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const canonicalBaseUrl = resolveRepresentativePublicBaseUrl(request, env);
  return !(
    canonicalBaseUrl.protocol === "http:"
    && isLoopbackRepresentativeHostname(canonicalBaseUrl.hostname)
  );
}

export function readPublicChatSessionState(params: {
  representativeSlug: string;
  cookieValue: string | undefined;
  now?: Date;
}): PublicChatSessionState {
  if (!params.cookieValue) {
    return createPublicChatSessionState({ now: params.now });
  }

  const [encodedPayload, encodedSignature] = params.cookieValue.split(".");
  if (!encodedPayload || !encodedSignature) {
    return createPublicChatSessionState({ now: params.now });
  }

  const expectedSignature = signPublicChatPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(encodedSignature);
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return createPublicChatSessionState({ now: params.now });
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<PublicChatSessionCookiePayload>;

    if (
      payload.version !== PUBLIC_CHAT_STATE_VERSION ||
      payload.representativeSlug !== params.representativeSlug ||
      !isValidAudienceId(payload.audienceId) ||
      typeof payload.sessionToken !== "string" ||
      payload.sessionToken.length < 24 ||
      typeof payload.expiresAt !== "string" ||
      Date.parse(payload.expiresAt) <= (params.now ?? new Date()).getTime()
    ) {
      return createPublicChatSessionState({ now: params.now });
    }

    return {
      audienceId: payload.audienceId,
      sessionToken: payload.sessionToken,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return createPublicChatSessionState({ now: params.now });
  }
}

export function writePublicChatSessionState(params: {
  representativeSlug: string;
  state: PublicChatSessionState;
}) {
  const payload: PublicChatSessionCookiePayload = {
    version: PUBLIC_CHAT_STATE_VERSION,
    representativeSlug: params.representativeSlug,
    audienceId: params.state.audienceId,
    sessionToken: params.state.sessionToken,
    expiresAt: params.state.expiresAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );

  return `${encodedPayload}.${signPublicChatPayload(encodedPayload)}`;
}

export function appendPublicChatTurns(params: {
  state: PublicChatSessionState;
  userMessage: string;
  assistantMessage: string;
  nextStep?: string;
}) {
  void params.userMessage;
  void params.assistantMessage;
  void params.nextStep;
  return params.state;
}

export function createEmptyPublicChatSessionState(): PublicChatSessionState {
  return createPublicChatSessionState();
}

export function createPublicChatSessionState(params: {
  now?: Date | undefined;
} = {}): PublicChatSessionState {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PUBLIC_CHAT_COOKIE_MAX_AGE_SECONDS * 1000);

  return {
    audienceId: `${PUBLIC_CHAT_AUDIENCE_ID_PREFIX}_${randomBytes(16).toString("base64url")}`,
    sessionToken: randomBytes(32).toString("base64url"),
    expiresAt: expiresAt.toISOString(),
  };
}

function signPublicChatPayload(encodedPayload: string) {
  return createHmac("sha256", getPublicChatSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function getPublicChatSessionSecret() {
  const secret =
    process.env.REP_PUBLIC_CHAT_SESSION_SECRET?.trim() ||
    process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("REP_PUBLIC_CHAT_SESSION_SECRET is required in production.");
  }

  return "delegate-public-chat-dev-secret";
}

function isValidAudienceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${PUBLIC_CHAT_AUDIENCE_ID_PREFIX}_`) &&
    value.length > PUBLIC_CHAT_AUDIENCE_ID_PREFIX.length + 8
  );
}

function truncateRecentTurnText(value: string) {
  const normalized = value.trim();
  return normalized.length > PUBLIC_CHAT_TURN_TEXT_LIMIT
    ? normalized.slice(0, PUBLIC_CHAT_TURN_TEXT_LIMIT)
    : normalized;
}
