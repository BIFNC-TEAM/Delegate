import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  contactMemorySharingConsentContractVersion,
  createContactMemorySharingChallenge,
  getContactMemorySharingState,
  grantContactMemorySharingConsent,
  revokeContactMemorySharingConsent,
} from "@delegate/web-data";

import {
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
} from "../public-principal";

type MemorySharingState = Awaited<
  ReturnType<typeof getContactMemorySharingState>
>;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const { principal, revalidate } =
      await requireAuthenticatedAudience(slug);
    await revalidate();
    const state = await getContactMemorySharingState({
      representativeSlug: slug,
      audienceIdentityId: principal.audienceIdentityId,
    });
    if (state.active || !state.policyEnabled) {
      return noStoreJson(toPublicMemorySharingState(state));
    }
    const evidence = requireWebSourceEvidence(principal);
    const challenge = await createContactMemorySharingChallenge({
      representativeSlug: slug,
      audienceIdentityId: principal.audienceIdentityId,
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: `web-disclosure:${randomUUID()}`,
      sourceChannel: "WEB",
      ...evidence,
    });
    if (state.blockedReason === "consent_missing") {
      await grantContactMemorySharingConsent({
        representativeSlug: slug,
        audienceIdentityId: principal.audienceIdentityId,
        sourceChannel: "WEB",
        challengeToken: challenge.challengeToken,
        sourceEventKey: `web-default-confirmation:${randomUUID()}`,
        ...evidence,
      });
      const enabledState = await getContactMemorySharingState({
        representativeSlug: slug,
        audienceIdentityId: principal.audienceIdentityId,
      });
      return noStoreJson(toPublicMemorySharingState(enabledState));
    }
    return noStoreJson(toPublicMemorySharingState(state, challenge));
  } catch (error) {
    return memorySharingError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const { principal, revalidate } =
      await requireAuthenticatedAudience(slug);
    const { challengeToken } = await readConsentRequest(request);
    await revalidate();
    const evidence = requireWebSourceEvidence(principal);
    await grantContactMemorySharingConsent({
      representativeSlug: slug,
      audienceIdentityId: principal.audienceIdentityId,
      sourceChannel: "WEB",
      challengeToken,
      sourceEventKey: `web-confirmation:${randomUUID()}`,
      ...evidence,
    });
    const state = await getContactMemorySharingState({
      representativeSlug: slug,
      audienceIdentityId: principal.audienceIdentityId,
    });
    return noStoreJson(toPublicMemorySharingState(state));
  } catch (error) {
    return memorySharingError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const { principal, revalidate } =
      await requireAuthenticatedAudience(slug);
    await revalidate();
    const result = await revokeContactMemorySharingConsent({
      representativeSlug: slug,
      audienceIdentityId: principal.audienceIdentityId,
      sourceChannel: "WEB",
    });
    const state = await getContactMemorySharingState({
      representativeSlug: slug,
      audienceIdentityId: principal.audienceIdentityId,
    });
    return noStoreJson({
      ...toPublicMemorySharingState(state),
      changed: result.changed === true,
      matchedMemoryCount: safeCount(result.matchedMemoryCount),
      queuedDeletionCount: safeCount(result.queuedDeletionCount),
    });
  } catch (error) {
    return memorySharingError(error);
  }
}

async function requireAuthenticatedAudience(representativeSlug: string) {
  const requestPrincipal = await resolvePublicAudienceRequestPrincipal({
    representativeSlug,
    cookieStore: await cookies(),
  });
  if (requestPrincipal.principal.mode !== "authenticated") {
    throw new MemorySharingHttpError(
      401,
      "Sign in before managing cross-channel memory.",
    );
  }
  return requestPrincipal;
}

async function readConsentRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new MemorySharingHttpError(400, "A JSON request body is required.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MemorySharingHttpError(400, "Invalid memory-sharing request.");
  }
  const value = body as Record<string, unknown>;
  const challengeToken =
    typeof value.challengeToken === "string"
      ? value.challengeToken.trim()
      : "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(challengeToken)) {
    throw new MemorySharingHttpError(
      400,
      "A valid one-time memory-sharing challenge is required.",
    );
  }
  return { challengeToken };
}

function requireWebSourceEvidence(principal: {
  sourceIdentityLinkId: string | null;
  sourceIdentityEvidence: {
    providerSubject: string;
    issuer: string;
    connectionId: string;
  } | null;
}) {
  if (!principal.sourceIdentityLinkId || !principal.sourceIdentityEvidence) {
    throw new MemorySharingHttpError(
      401,
      "A current verified sign-in is required for cross-channel memory.",
    );
  }
  return {
    sourceIdentityLinkId: principal.sourceIdentityLinkId,
    providerSubject: principal.sourceIdentityEvidence.providerSubject,
    issuer: principal.sourceIdentityEvidence.issuer,
    connectionId: principal.sourceIdentityEvidence.connectionId,
  };
}

function toPublicMemorySharingState(
  state: MemorySharingState,
  challenge?: {
    challengeToken: string;
    challengeExpiresAt: string;
  },
) {
  return {
    supported: state.supported === true,
    policyEnabled: state.policyEnabled === true,
    active: state.active === true,
    contractVersion: safeContractVersion(state.contractVersion),
    grantedAt: safeDate(state.grantedAt),
    sourceChannel: safeChannel(state.sourceChannel),
    blockedReason: safeBlockedReason(state.blockedReason),
    challengeToken: safeChallengeToken(challenge?.challengeToken),
    challengeExpiresAt: safeDate(challenge?.challengeExpiresAt),
  };
}

function safeChallengeToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value)
    ? value
    : null;
}

function safeContractVersion(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ? value
    : "unavailable";
}

function safeDate(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeChannel(value: unknown): "WEB" | "MATRIX" | "TELEGRAM" | null {
  return value === "WEB" || value === "MATRIX" || value === "TELEGRAM"
    ? value
    : null;
}

function safeBlockedReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return publicBlockedReasons.has(normalized) ? normalized : "unavailable";
}

function safeCount(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : 0;
}

const publicBlockedReasons = new Set([
  "policy_disabled",
  "identity_ineligible",
  "consent_missing",
  "consent_stale",
  "user_disabled",
  "contact_memory_disabled",
  "cross_channel_disabled",
  "identity_not_registered",
  "verified_identity_required",
  "consent_required",
  "contract_stale",
  "representative_not_found",
]);

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
    },
  });
}

function memorySharingError(error: unknown) {
  const status =
    publicAudiencePrincipalErrorStatus(error)
    ?? serviceErrorStatus(error)
    ?? (error instanceof MemorySharingHttpError ? error.status : 500);
  return noStoreJson(
    {
      error:
        status === 401
          ? "Sign in before managing cross-channel memory."
          : status === 409 || status === 410 || status === 422
            ? "Memory-sharing policy or disclosure changed. Refresh and confirm again."
            : error instanceof MemorySharingHttpError
              ? error.message
              : "Unable to manage cross-channel memory.",
    },
    status,
  );
}

function serviceErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { status?: unknown; statusCode?: unknown };
  const status =
    typeof value.status === "number"
      ? value.status
      : typeof value.statusCode === "number"
        ? value.statusCode
        : null;
  return status !== null
    && Number.isInteger(status)
    && status >= 400
    && status <= 499
    ? status
    : null;
}

class MemorySharingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MemorySharingHttpError";
  }
}
