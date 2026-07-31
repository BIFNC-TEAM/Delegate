import {
  issueAccountSessionShadow,
  revokeAppSession,
  type IssueAccountSessionShadowInput,
  type IssuedAccountSessionShadow,
} from "@delegate/web-data";

type PublicAudienceAccountSessionShadowInput = Omit<
  IssueAccountSessionShadowInput,
  "application" | "persona"
> & {
  application: "PUBLIC_REPRESENTATIVES";
  persona: {
    kind: "audience";
    audienceIdentityId: string;
  };
};

export type PublicAudienceAccountSessionShadowOutcome =
  | {
      status: "issued";
      session: IssuedAccountSessionShadow;
    }
  | {
      status: "review_required";
      session: null;
    };

/**
 * Shadow mode must not make an otherwise-valid legacy audience login fail
 * merely because a second persona still needs an operator-approved Account
 * mapping. The core attach guard remains fail-closed; this compatibility
 * boundary records the drift and deliberately omits the v2 AppSession.
 */
export async function issuePublicAudienceAccountSessionShadow(
  input: PublicAudienceAccountSessionShadowInput,
): Promise<PublicAudienceAccountSessionShadowOutcome> {
  try {
    return {
      status: "issued",
      session: await issueAccountSessionShadow(input),
    };
  } catch (error) {
    if (!isCrossPersonaReviewRequired(error)) {
      throw error;
    }

    const previousToken =
      typeof input.previousToken === "string"
        ? input.previousToken.trim()
        : "";
    let previousSessionRevoked = false;
    let previousSessionRevocationFailed = false;
    if (previousToken) {
      try {
        previousSessionRevoked = await revokeAppSession({
          token: previousToken,
          application: "PUBLIC_REPRESENTATIVES",
          reason: "CROSS_PERSONA_REVIEW_REQUIRED",
          now: input.now,
        });
      } catch {
        // The response also deletes the browser token. Shadow cleanup remains
        // best-effort so a database outage cannot promote this review-only
        // mismatch back into a legacy login failure.
        previousSessionRevocationFailed = true;
      }
    }

    console.warn(
      "Account/AppSession shadow issuance requires cross-persona review.",
      {
        event: "account_session_shadow_review_required",
        application: "PUBLIC_REPRESENTATIVES",
        reason: "CROSS_PERSONA_REVIEW_REQUIRED",
        previousSessionPresent: Boolean(previousToken),
        previousSessionRevoked,
        previousSessionRevocationFailed,
      },
    );

    return {
      status: "review_required",
      session: null,
    };
  }
}

function isCrossPersonaReviewRequired(
  error: unknown,
): error is Error & {
  code: "ACCOUNT_SESSION_PERSONA_CONFLICT";
  reason: "CROSS_PERSONA_REVIEW_REQUIRED";
} {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & {
    code?: unknown;
    reason?: unknown;
  };
  return (
    candidate.code === "ACCOUNT_SESSION_PERSONA_CONFLICT"
    && candidate.reason === "CROSS_PERSONA_REVIEW_REQUIRED"
  );
}
