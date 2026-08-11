import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  verifyAgentUsageEntitlementReservation,
  type VerifiedAgentUsageEntitlementReservation,
} from "@delegate/web-data";

import { prisma } from "./prisma";
import { SessionError } from "./session-error";

const ACTIVE_AUDIENCE_RUN_STATUSES = new Set([
  "PROCESSING",
  "WAITING_APPROVAL",
]);

type AudienceAuthorizationClient = Pick<
  typeof prisma,
  "generationRun" | "serviceEntitlementAccount" | "serviceEntitlementLedgerEntry"
>;

type WalletReservationVerifier = typeof verifyAgentUsageEntitlementReservation;

type AudienceGenerationRunAuthorizationBase = {
  audienceIdentityId: string;
  generationRunId: string;
  representativeId: string;
};

export type AudienceGenerationRunAuthorization =
  | (AudienceGenerationRunAuthorizationBase & {
      kind: "free";
      productCode: null;
      activePlanTier: undefined;
      hasPaidEntitlement: false;
    })
  | (AudienceGenerationRunAuthorizationBase & {
      kind: "wallet";
      productCode: string;
      activePlanTier: "pass" | "deep_help";
      hasPaidEntitlement: true;
    });

export type AudienceGenerationRunAuthorizationInput = {
  requestedBy: string;
  representativeId: string;
  contactId?: string | null;
  conversationId?: string | null;
  generationRunId?: string | null;
};

/**
 * Revalidates the server-owned authorization for audience compute. This must
 * run both before a session is created and immediately before each execution,
 * because an approval wait can outlive the underlying reservation.
 */
export async function requireAudienceGenerationRunAuthorization(
  input: AudienceGenerationRunAuthorizationInput,
  client: AudienceAuthorizationClient = prisma,
  walletVerifier: WalletReservationVerifier =
    verifyAgentUsageEntitlementReservation,
): Promise<AudienceGenerationRunAuthorization | null> {
  if (input.requestedBy.trim().toLowerCase() !== "audience") return null;

  const generationRunId = input.generationRunId?.trim();
  if (!generationRunId) {
    throw new SessionError(403, "audience_generation_run_required");
  }
  const representativeId = input.representativeId.trim();
  const contactId = input.contactId?.trim();
  const conversationId = input.conversationId?.trim();
  if (!representativeId || !contactId || !conversationId) {
    throwAudienceAuthorizationDenied();
  }

  const run = await client.generationRun.findUnique({
    where: { id: generationRunId },
    select: {
      id: true,
      status: true,
      conversationId: true,
      runtimePolicySnapshot: true,
      conversation: {
        select: {
          id: true,
          representativeId: true,
          contactId: true,
          audienceIdentityId: true,
          audienceIdentity: {
            select: {
              id: true,
              status: true,
              mergedIntoId: true,
            },
          },
          contact: {
            select: {
              id: true,
              audienceIdentityId: true,
              audienceIdentity: {
                select: {
                  id: true,
                  status: true,
                  mergedIntoId: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (
    !run
    || run.id !== generationRunId
    || !ACTIVE_AUDIENCE_RUN_STATUSES.has(run.status)
    || run.conversationId !== conversationId
    || run.conversation.id !== conversationId
    || run.conversation.representativeId !== representativeId
    || run.conversation.contactId !== contactId
    || run.conversation.contact.id !== contactId
  ) {
    throwAudienceAuthorizationDenied();
  }

  const audienceIdentityId = requireMatchingActiveAudienceIdentity(run.conversation);
  const snapshot = readRuntimePolicySnapshot(run.runtimePolicySnapshot);
  const billingMode =
    typeof snapshot?.billingMode === "string"
      ? snapshot.billingMode
      : null;
  const hasWalletReservationField =
    snapshot !== null
    && Object.prototype.hasOwnProperty.call(snapshot, "walletReservation");

  if (billingMode === "service_credit") {
    const reservation = readServerStoredServiceCreditReservation(snapshot);
    if (!reservation) throwAudienceAuthorizationDenied();

    let verified: VerifiedAgentUsageEntitlementReservation;
    try {
      verified = await verifyRunScopedServiceCreditReservation(
        {
          audienceIdentityId,
          representativeId,
          generationRunId,
          usageChargeId: reservation.usageChargeId,
          tokenAmount: reservation.tokenAmount,
        },
        walletVerifier,
      );
    } catch {
      throwAudienceAuthorizationDenied();
    }
    if (
      verified.audienceIdentityId !== audienceIdentityId
      || verified.representativeId !== representativeId
      || verified.generationRunId !== generationRunId
      || verified.usageChargeId !== reservation.usageChargeId
      || verified.tokenAmount !== reservation.tokenAmount
      || verified.productCode !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
    ) {
      throwAudienceAuthorizationDenied();
    }

    const account = await client.serviceEntitlementAccount.findUnique({
      where: { id: verified.entitlementAccountId },
      select: {
        id: true,
        audienceIdentityId: true,
        representativeId: true,
        productCode: true,
        status: true,
        reservedUnits: true,
        expiresAt: true,
      },
    });
    if (
      !account
      || account.id !== verified.entitlementAccountId
      || account.audienceIdentityId !== audienceIdentityId
      || account.representativeId !== representativeId
      || account.productCode !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
      || account.status !== "ACTIVE"
      || account.reservedUnits < reservation.tokenAmount
      || isExpired(account.expiresAt)
    ) {
      throwAudienceAuthorizationDenied();
    }

    return {
      kind: "wallet",
      audienceIdentityId,
      generationRunId,
      representativeId,
      productCode: account.productCode,
      activePlanTier: "pass",
      hasPaidEntitlement: true,
    };
  }

  // A wallet marker without its one active billing mode is terminal or
  // malformed. Never fall back to another rail for the same run.
  if (
    hasWalletReservationField
    || (billingMode !== null && billingMode.startsWith("service_credit"))
  ) {
    throwAudienceAuthorizationDenied();
  }

  if (billingMode === "free") {
    return {
      kind: "free",
      audienceIdentityId,
      generationRunId,
      representativeId,
      productCode: null,
      activePlanTier: undefined,
      hasPaidEntitlement: false,
    };
  }
  throwAudienceAuthorizationDenied();
}

export async function verifyRunScopedServiceCreditReservation(
  input: {
    audienceIdentityId: string;
    representativeId: string;
    generationRunId: string;
    usageChargeId: string;
    tokenAmount: number;
  },
  verifier: WalletReservationVerifier =
    verifyAgentUsageEntitlementReservation,
) {
  return verifier({
    audienceIdentityId: input.audienceIdentityId,
    representativeId: input.representativeId,
    generationRunId: input.generationRunId,
    usageChargeId: input.usageChargeId,
    tokenAmount: input.tokenAmount,
  });
}

export function deriveConversationComputeEntitlements(
  authorization: AudienceGenerationRunAuthorization | null,
) {
  return authorization?.hasPaidEntitlement
    ? {
        hasPaidEntitlement: true as const,
        activePlanTier: authorization.activePlanTier,
      }
    : {
        hasPaidEntitlement: false as const,
        activePlanTier: undefined,
      };
}

export function hasServerStoredServiceCreditReservation(snapshot: unknown): boolean {
  return readServerStoredServiceCreditReservation(snapshot) !== null;
}

export function readServerStoredServiceCreditReservation(snapshot: unknown): {
  usageChargeId: string;
  tokenAmount: number;
} | null {
  const record = readRuntimePolicySnapshot(snapshot);
  if (!record || record.billingMode !== "service_credit") {
    return null;
  }
  const reservation = record.walletReservation;
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    return null;
  }
  const usageChargeId = (reservation as Record<string, unknown>).usageChargeId;
  const tokenAmount = (reservation as Record<string, unknown>).tokenAmount;
  if (
    typeof usageChargeId !== "string"
    || usageChargeId.trim().length === 0
    || typeof tokenAmount !== "number"
    || !Number.isSafeInteger(tokenAmount)
    || tokenAmount <= 0
  ) {
    return null;
  }
  return {
    usageChargeId: usageChargeId.trim(),
    tokenAmount,
  };
}

function requireMatchingActiveAudienceIdentity(conversation: {
  audienceIdentityId: string | null;
  audienceIdentity: {
    id: string;
    status: string;
    mergedIntoId: string | null;
  } | null;
  contact: {
    audienceIdentityId: string | null;
    audienceIdentity: {
      id: string;
      status: string;
      mergedIntoId: string | null;
    } | null;
  };
}) {
  const conversationIdentity = conversation.audienceIdentity;
  const contactIdentity = conversation.contact.audienceIdentity;
  if (
    !conversation.audienceIdentityId
    || !conversationIdentity
    || conversationIdentity.id !== conversation.audienceIdentityId
    || conversation.contact.audienceIdentityId !== conversation.audienceIdentityId
    || !contactIdentity
    || contactIdentity.id !== conversation.audienceIdentityId
    || !isActiveAudienceIdentity(conversationIdentity)
    || !isActiveAudienceIdentity(contactIdentity)
  ) {
    throwAudienceAuthorizationDenied();
  }
  return conversation.audienceIdentityId;
}

function isActiveAudienceIdentity(identity: {
  status: string;
  mergedIntoId: string | null;
}) {
  return (
    (identity.status === "ANONYMOUS" || identity.status === "REGISTERED")
    && identity.mergedIntoId === null
  );
}

function readRuntimePolicySnapshot(
  snapshot: unknown,
): Record<string, unknown> | null {
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : null;
}

function isExpired(expiresAt: Date | null) {
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

function throwAudienceAuthorizationDenied(): never {
  throw new SessionError(403, "audience_generation_run_authorization_denied");
}
