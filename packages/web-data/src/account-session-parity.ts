import { createHash } from "node:crypto";

export type AccountSessionParityApplication =
  | "DASHBOARD"
  | "PUBLIC_REPRESENTATIVES";
export type AccountSessionParityOutcome =
  | "MATCH"
  | "V2_COOKIE_MISSING"
  | "V2_PRINCIPAL_INVALID"
  | "PRINCIPAL_MISMATCH";

type ParityPrincipal = {
  actor: "owner" | "audience";
  issuer?: string | undefined;
  subject: string;
  personaId: string;
  audienceId?: string | undefined;
};

type ParityLogger = Pick<Console, "info" | "warn">;

/**
 * Compares shadow authority without logging token, subject, issuer, email, or
 * persona IDs. Every mismatch is emitted; matches are deterministically sampled
 * at 1% by the opaque v2 token so one session cannot flood logs.
 */
export function observeAccountSessionParity(
  input: {
    application: AccountSessionParityApplication;
    legacy: ParityPrincipal;
    v2: ParityPrincipal | null;
    v2Token: string | null;
  },
  logger: ParityLogger = console,
): AccountSessionParityOutcome {
  const outcome = classifyParity(input);
  const event = {
    event: "account_session_shadow_parity",
    application: input.application,
    outcome,
    containsPii: false,
  } as const;
  if (outcome !== "MATCH") {
    logger.warn("Account/AppSession shadow parity mismatch.", event);
  } else if (input.v2Token && shouldSampleMatch(input.v2Token)) {
    logger.info("Account/AppSession shadow parity sample.", event);
  }
  return outcome;
}

function classifyParity(input: {
  legacy: ParityPrincipal;
  v2: ParityPrincipal | null;
  v2Token: string | null;
}): AccountSessionParityOutcome {
  if (!input.v2Token) return "V2_COOKIE_MISSING";
  if (!input.v2) return "V2_PRINCIPAL_INVALID";
  if (
    input.legacy.actor !== input.v2.actor
    || normalize(input.legacy.issuer) !== normalize(input.v2.issuer)
    || input.legacy.subject.trim() !== input.v2.subject.trim()
    || input.legacy.personaId.trim() !== input.v2.personaId.trim()
    || normalize(input.legacy.audienceId)
      !== normalize(input.v2.audienceId)
  ) {
    return "PRINCIPAL_MISMATCH";
  }
  return "MATCH";
}

function shouldSampleMatch(token: string): boolean {
  const digest = createHash("sha256").update(token, "utf8").digest();
  return (digest.at(0) ?? 255) < 3;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
