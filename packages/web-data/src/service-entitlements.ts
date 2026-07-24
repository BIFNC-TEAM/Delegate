import {
  PaymentProvider,
  PaymentProviderEventType,
  Prisma,
  RechargeOrderStatus,
} from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

const ENTITLEMENT_STATUSES = {
  ACTIVE: "ACTIVE",
  FROZEN: "FROZEN",
  EXHAUSTED: "EXHAUSTED",
  EXPIRED: "EXPIRED",
} as const;

const LEDGER_KINDS = {
  GRANT: "GRANT",
  RESERVE: "RESERVE",
  CONSUME: "CONSUME",
  RELEASE: "RELEASE",
  REFUND: "REFUND",
} as const;

type EntitlementStatus =
  (typeof ENTITLEMENT_STATUSES)[keyof typeof ENTITLEMENT_STATUSES];
type EntitlementLedgerKind =
  (typeof LEDGER_KINDS)[keyof typeof LEDGER_KINDS];

type EntitlementAccountRecord = {
  id: string;
  audienceIdentityId: string;
  representativeId: string;
  productCode: string;
  unitName: string;
  status: EntitlementStatus;
  grantedUnits: number;
  remainingUnits: number;
  reservedUnits: number;
  expiresAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type EntitlementLedgerRecord = {
  id: string;
  entitlementAccountId: string;
  paymentOrderId: string | null;
  generationRunId: string | null;
  kind: EntitlementLedgerKind;
  units: number;
  balanceAfter: number;
  reservedAfter: number;
  idempotencyKey: string;
  notes: string | null;
  metadata: unknown;
  createdAt: Date;
};

type ServicePaymentOrderRecord = {
  id: string;
  payerAudienceIdentityId: string;
  representativeId: string;
  provider: PaymentProvider;
  providerAccountId: string;
  providerOrderId: string | null;
  providerOrderKey: string | null;
  productCode: string;
  amountMinor: number;
  currency: string;
  entitlementUnits: number;
  priceSnapshot: unknown;
  checkoutUrl: string | null;
  providerPayload: unknown;
  status: RechargeOrderStatus;
  fulfillmentKey: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
};

type ServicePaymentEventRecord = {
  id: string;
  paymentOrderId: string | null;
  provider: PaymentProvider;
  providerAccountId: string;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  verifiedAt: Date | null;
  processedAt: Date | null;
};

type UpdateManyResult = {
  count: number;
};

/**
 * This intentionally describes only the Prisma operations used below. It keeps
 * the domain service testable with an in-memory fake without weakening the
 * production invariants.
 *
 * PostgreSQL semantics:
 * - every mutation runs in a SERIALIZABLE interactive transaction;
 * - debit-like changes use one conditional UPDATE (`updateMany`) whose WHERE
 *   clause includes the required balance, so two callers cannot both spend the
 *   same units;
 * - ledger and payment keys are unique. If concurrent calls race on a key, the
 *   losing transaction is rolled back, including its account increment/debit;
 * - P2034 serialization/deadlock failures are retried by the shared retry
 *   helper. A fake client must make `$transaction` rollback on failure to model
 *   these guarantees faithfully.
 */
export type ServiceEntitlementClient = {
  audienceIdentity?: {
    findUnique(args: unknown): Promise<{
      id: string;
      status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
      mergedIntoId: string | null;
    } | null>;
  };
  serviceEntitlementAccount: {
    findUnique(args: unknown): Promise<EntitlementAccountRecord | null>;
    upsert(args: unknown): Promise<EntitlementAccountRecord>;
    update(args: unknown): Promise<EntitlementAccountRecord>;
    updateMany(args: unknown): Promise<UpdateManyResult>;
  };
  serviceEntitlementLedgerEntry: {
    findUnique(args: unknown): Promise<EntitlementLedgerRecord | null>;
    findMany(args: unknown): Promise<EntitlementLedgerRecord[]>;
    create(args: unknown): Promise<EntitlementLedgerRecord>;
  };
  servicePaymentOrder: {
    findUnique(args: unknown): Promise<ServicePaymentOrderRecord | null>;
    findFirst(args: unknown): Promise<ServicePaymentOrderRecord | null>;
    create(args: unknown): Promise<ServicePaymentOrderRecord>;
    updateMany(args: unknown): Promise<UpdateManyResult>;
  };
  servicePaymentEvent: {
    findUnique(args: unknown): Promise<ServicePaymentEventRecord | null>;
    create(args: unknown): Promise<ServicePaymentEventRecord>;
    update(args: unknown): Promise<ServicePaymentEventRecord>;
  };
  $transaction?<T>(
    fn: (tx: ServiceEntitlementClient) => Promise<T>,
    options?: { isolationLevel?: "Serializable" },
  ): Promise<T>;
};

export class ServiceEntitlementError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "ACCOUNT_NOT_FOUND"
      | "ACCOUNT_UNAVAILABLE"
      | "INSUFFICIENT_UNITS"
      | "PAYMENT_NOT_FOUND"
      | "PAYMENT_MISMATCH"
      | "PAYMENT_STATE"
      | "INVARIANT_VIOLATION",
    message: string,
  ) {
    super(message);
    this.name = "ServiceEntitlementError";
  }
}

export type ServiceEntitlementCoordinates = {
  audienceIdentityId: string;
  representativeId: string;
  productCode: string;
};

type MutationMetadata = {
  operationKey: string;
  generationRunId?: string;
  notes?: string;
  metadata?: unknown;
};

export type GrantServiceEntitlementInput = ServiceEntitlementCoordinates &
  MutationMetadata & {
    units: number;
    unitName?: string;
    expiresAt?: Date | null;
  };

export type ReserveServiceEntitlementInput = ServiceEntitlementCoordinates &
  MutationMetadata & {
    units: number;
  };

export type ConsumeServiceEntitlementInput = ServiceEntitlementCoordinates &
  MutationMetadata & {
    units: number;
  };

export type ReleaseServiceEntitlementInput = ServiceEntitlementCoordinates &
  MutationMetadata & {
    units: number;
  };

export type ServiceEntitlementSnapshot = {
  accountId: string;
  audienceIdentityId: string;
  representativeId: string;
  productCode: string;
  unitName: string;
  status: EntitlementStatus;
  grantedUnits: number;
  remainingUnits: number;
  reservedUnits: number;
  expiresAt: string | null;
  ledgerEntryId: string;
  ledgerKind: EntitlementLedgerKind;
  units: number;
  idempotencyKey: string;
};

export type ConversationEntitlementReservation = {
  audienceIdentityId: string;
  representativeId: string;
  productCode: string;
  generationRunId: string;
  operationKey: string;
  accountId: string;
  attempt: number;
};

export type CreateServicePaymentOrderInput = {
  id: string;
  payerAudienceIdentityId: string;
  representativeId: string;
  provider: PaymentProvider;
  providerAccountId: string;
  providerOrderId: string;
  productCode: string;
  amountMinor: number;
  currency: string;
  entitlementUnits: number;
  priceSnapshot: unknown;
  checkoutUrl?: string;
  providerPayload?: unknown;
  status?: "CREATED" | "REQUIRES_PAYMENT";
};

export type ServicePaymentEvidenceInput = {
  paymentOrderId: string;
  provider: PaymentProvider;
  providerAccountId: string;
  providerOrderId: string;
  providerEventId: string;
  payerAudienceIdentityId: string;
  amountMinor: number;
  currency: string;
  verifiedAt: Date;
  rawPayload: unknown;
  normalizedPayload?: unknown;
};

export type ServicePaymentFulfillmentSnapshot = {
  paymentOrderId: string;
  paymentEventId: string | null;
  paymentStatus: "PAID" | "REFUNDED";
  provider: PaymentProvider;
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  entitlement: ServiceEntitlementSnapshot;
};

export function serviceEntitlementOperationKey(
  kind: EntitlementLedgerKind,
  coordinates: ServiceEntitlementCoordinates,
  operationKey: string,
): string {
  const normalizedOperationKey = requiredText(operationKey, "operationKey");
  return [
    "service-entitlement",
    kind.toLowerCase(),
    encodeKeyPart(coordinates.audienceIdentityId, "audienceIdentityId"),
    encodeKeyPart(coordinates.representativeId, "representativeId"),
    encodeKeyPart(coordinates.productCode, "productCode"),
    encodeURIComponent(normalizedOperationKey),
  ].join(":");
}

export function servicePaymentProviderOrderKey(input: {
  provider: PaymentProvider;
  providerAccountId: string;
  providerOrderId: string;
}): string {
  return [
    "service-payment",
    input.provider.toLowerCase(),
    encodeKeyPart(input.providerAccountId, "providerAccountId"),
    encodeKeyPart(input.providerOrderId, "providerOrderId"),
  ].join(":");
}

/**
 * Creates the immutable provider-facing payment order fact exactly once.
 * Provider adapters may retry checkout creation, but they cannot reuse either
 * the internal order id or provider order id with different commercial terms.
 */
export async function createServicePaymentOrder(
  input: CreateServicePaymentOrderInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServicePaymentOrderRecord> {
  const normalized = normalizeCreatePaymentOrderInput(input);
  return runAtomically(client, async (tx) => {
    const [existingById, existingByProviderOrder] = await Promise.all([
      tx.servicePaymentOrder.findUnique({
        where: { id: normalized.id },
      }),
      tx.servicePaymentOrder.findUnique({
        where: { providerOrderKey: normalized.providerOrderKey },
      }),
    ]);
    const existing = existingById ?? existingByProviderOrder;
    if (existing) {
      assertSameServicePaymentOrder(existing, normalized);
      return existing;
    }

    return tx.servicePaymentOrder.create({
      data: {
        id: normalized.id,
        payerAudienceIdentityId: normalized.payerAudienceIdentityId,
        representativeId: normalized.representativeId,
        provider: normalized.provider,
        providerAccountId: normalized.providerAccountId,
        providerOrderId: normalized.providerOrderId,
        providerOrderKey: normalized.providerOrderKey,
        productCode: normalized.productCode,
        amountMinor: normalized.amountMinor,
        currency: normalized.currency,
        entitlementUnits: normalized.entitlementUnits,
        status: normalized.status,
        priceSnapshot: normalized.priceSnapshot,
        ...(normalized.checkoutUrl ? { checkoutUrl: normalized.checkoutUrl } : {}),
        ...(normalized.providerPayload === undefined
          ? {}
          : { providerPayload: normalized.providerPayload }),
      },
    });
  });
}

export async function grantServiceEntitlement(
  input: GrantServiceEntitlementInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const normalized = normalizeGrantInput(input);
  return runAtomically(client, (tx) =>
    grantWithinTransaction(
      {
        ...normalized,
        idempotencyKey: serviceEntitlementOperationKey(
          LEDGER_KINDS.GRANT,
          normalized,
          normalized.operationKey,
        ),
      },
      tx,
    ),
  );
}

export async function reserveServiceEntitlement(
  input: ReserveServiceEntitlementInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const normalized = normalizeUnitMutationInput(input);
  return runAtomically(client, (tx) =>
    moveAvailableToReserved(
      normalized,
      serviceEntitlementOperationKey(
        LEDGER_KINDS.RESERVE,
        normalized,
        normalized.operationKey,
      ),
      tx,
    ),
  );
}

export async function consumeServiceEntitlement(
  input: ConsumeServiceEntitlementInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const normalized = normalizeUnitMutationInput(input);
  return runAtomically(client, (tx) =>
    consumeReserved(
      normalized,
      serviceEntitlementOperationKey(
        LEDGER_KINDS.CONSUME,
        normalized,
        normalized.operationKey,
      ),
      tx,
    ),
  );
}

export async function releaseServiceEntitlement(
  input: ReleaseServiceEntitlementInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const normalized = normalizeUnitMutationInput(input);
  return runAtomically(client, (tx) =>
    releaseReserved(
      normalized,
      serviceEntitlementOperationKey(
        LEDGER_KINDS.RELEASE,
        normalized,
        normalized.operationKey,
      ),
      tx,
    ),
  );
}

/**
 * Reserves one cross-channel chat unit, preferring the more capable plan.
 * Missing, expired, exhausted, or frozen products are skipped; invariant and
 * persistence failures still fail closed.
 */
export async function reserveConversationEntitlement(
  input: {
    audienceIdentityId: string;
    representativeId: string;
    generationRunId: string;
    productCodes?: string[];
  },
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ConversationEntitlementReservation | null> {
  const generationRunId = requiredText(input.generationRunId, "generationRunId");
  const representativeId = requiredText(input.representativeId, "representativeId");
  const requestedAudienceIdentityId = requiredText(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const requestedProductCodes = normalizeConversationProductCodes(input.productCodes);

  return runAtomically(client, async (tx) => {
    const history = await loadConversationEntitlementHistory(generationRunId, tx);
    const currentAttempt = latestConversationEntitlementAttempt(history);
    const canonicalRequestedAudienceIdentityId =
      await resolveEntitlementAudienceIdentityId(
        requestedAudienceIdentityId,
        tx,
      );
    const currentAccount = currentAttempt
      ? await requireAccountById(currentAttempt.reserve.entitlementAccountId, tx)
      : null;
    if (
      currentAccount &&
      currentAccount.audienceIdentityId !== canonicalRequestedAudienceIdentityId
    ) {
      throw new ServiceEntitlementError(
        "INVALID_INPUT",
        "Generation run entitlement history belongs to a different audience identity.",
      );
    }
    if (currentAttempt && !currentAttempt.release) {
      assertConversationEntitlementAccount(
        currentAccount!,
        representativeId,
        requestedProductCodes,
      );
      return serializeConversationReservation({
        account: currentAccount!,
        generationRunId,
        attempt: currentAttempt.attempt,
      });
    }

    const attempt = (currentAttempt?.attempt ?? 0) + 1;
    const canonicalAudienceIdentityId =
      currentAccount?.audienceIdentityId ?? canonicalRequestedAudienceIdentityId;
    const previousProductCode = currentAttempt?.release
      ? currentAccount!.productCode
      : null;
    const productCodes = previousProductCode
      ? [
          previousProductCode,
          ...requestedProductCodes.filter((productCode) => productCode !== previousProductCode),
        ]
      : requestedProductCodes;

    for (const productCode of productCodes) {
      const coordinates = {
        audienceIdentityId: canonicalAudienceIdentityId,
        representativeId,
        productCode,
      };
      try {
        const reserved = await moveAvailableToReserved(
          normalizeUnitMutationInput({
            ...coordinates,
            units: 1,
            operationKey: conversationEntitlementAttemptKey(generationRunId, attempt),
            generationRunId,
            notes: "Reserved for a cross-channel conversation reply.",
            metadata: {
              scope: "conversation_reply",
              reservationAttempt: attempt,
            },
          }),
          conversationEntitlementLedgerKey("reserve", generationRunId, attempt),
          tx,
        );
        return {
          ...coordinates,
          generationRunId,
          operationKey: conversationEntitlementAttemptKey(generationRunId, attempt),
          accountId: reserved.accountId,
          attempt,
        };
      } catch (error) {
        if (isSkippableConversationEntitlementError(error)) continue;
        throw error;
      }
    }
    return null;
  });
}

export async function hasUnifiedConversationEntitlement(
  input: {
    audienceIdentityId: string;
    representativeId: string;
    productCodes?: string[];
  },
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
) {
  const audienceIdentityId = await resolveEntitlementAudienceIdentityId(
    requiredText(input.audienceIdentityId, "audienceIdentityId"),
    client,
  );
  const representativeId = requiredText(input.representativeId, "representativeId");
  const productCodes = normalizeConversationProductCodes(input.productCodes);

  for (const productCode of productCodes) {
    const account = await client.serviceEntitlementAccount.findUnique({
      where: {
        audienceIdentityId_representativeId_productCode: {
          audienceIdentityId,
          representativeId,
          productCode,
        },
      },
    });
    if (account) return true;
  }

  return Boolean(
    await client.servicePaymentOrder.findFirst({
      where: {
        payerAudienceIdentityId: audienceIdentityId,
        representativeId,
        productCode: { in: productCodes },
        status: {
          in: [RechargeOrderStatus.PAID, RechargeOrderStatus.REFUNDED],
        },
      },
    }),
  );
}

export function consumeConversationEntitlement(
  reservation: ConversationEntitlementReservation,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
) {
  return runAtomically(client, async (tx) => {
    const normalized = normalizeConversationReservation(reservation);
    const reserveEntry = await requireConversationReserveEntry(normalized, tx);
    const consumeKey = conversationEntitlementLedgerKey(
      "consume",
      normalized.generationRunId,
      normalized.attempt,
    );
    const releaseKey = conversationEntitlementLedgerKey(
      "release",
      normalized.generationRunId,
      normalized.attempt,
    );
    const existingConsume = await tx.serviceEntitlementLedgerEntry.findUnique({
      where: { idempotencyKey: consumeKey },
    });
    if (existingConsume) {
      return serializeExistingConversationMutation(
        existingConsume,
        LEDGER_KINDS.CONSUME,
        normalized,
        tx,
      );
    }
    if (
      await tx.serviceEntitlementLedgerEntry.findUnique({
        where: { idempotencyKey: releaseKey },
      })
    ) {
      throw new ServiceEntitlementError(
        "ACCOUNT_UNAVAILABLE",
        "Conversation entitlement reservation was already released.",
      );
    }

    const account = await requireAccountById(reserveEntry.entitlementAccountId, tx);
    assertConversationReservationAccount(account, normalized);
    return consumeReserved(
      normalizeUnitMutationInput({
        audienceIdentityId: account.audienceIdentityId,
        representativeId: account.representativeId,
        productCode: account.productCode,
        units: 1,
        operationKey: normalized.operationKey,
        generationRunId: normalized.generationRunId,
        notes: "Consumed by a completed cross-channel conversation reply.",
        metadata: {
          scope: "conversation_reply",
          reservationAttempt: normalized.attempt,
        },
      }),
      consumeKey,
      tx,
    );
  });
}

export function releaseConversationEntitlement(
  reservation: ConversationEntitlementReservation,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
) {
  return runAtomically(client, async (tx) => {
    const normalized = normalizeConversationReservation(reservation);
    return releaseConversationReservationInTransaction(normalized, tx);
  });
}

/**
 * Recovers an in-flight conversation reservation from its durable ledger and
 * releases it. Terminal run paths use this after a worker crash, when the
 * in-memory reservation handle no longer exists.
 *
 * A consumed or already released reservation is a successful no-op: consumed
 * units must never be credited back, and cleanup may be retried safely.
 */
export function releaseConversationEntitlementByGenerationRunId(
  input: {
    generationRunId: string;
    reason?: string;
  },
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot | null> {
  const generationRunId = requiredText(input.generationRunId, "generationRunId");
  const reason = optionalText(input.reason);
  return runAtomically(client, async (tx) => {
    const history = await loadConversationEntitlementHistory(generationRunId, tx);
    const activeAttempts = history.filter(
      (attempt) => !attempt.consume && !attempt.release,
    );
    if (activeAttempts.length === 0) return null;
    if (activeAttempts.length > 1) {
      throw new ServiceEntitlementError(
        "INVARIANT_VIOLATION",
        "Generation run contains multiple active conversation entitlement reservations.",
      );
    }

    const activeAttempt = activeAttempts[0]!;
    const account = await requireAccountById(
      activeAttempt.reserve.entitlementAccountId,
      tx,
    );
    const reservation = normalizeConversationReservation(
      serializeConversationReservation({
        account,
        generationRunId,
        attempt: activeAttempt.attempt,
      }),
    );
    return releaseConversationReservationInTransaction(
      reservation,
      tx,
      reason
        ? `Released after generation run termination: ${reason}.`
        : "Released after generation run termination.",
    );
  });
}

/**
 * Fulfils a previously-created ServicePaymentOrder. The caller must provide
 * evidence from a signature-verified provider webhook. Every immutable payment
 * fact is compared with the order before the order can be claimed and units
 * granted.
 */
export async function fulfillServicePaymentOrder(
  input: ServicePaymentEvidenceInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServicePaymentFulfillmentSnapshot> {
  const normalized = normalizePaymentEvidence(input);
  return runAtomically(client, async (tx) => {
    const order = await loadAndValidatePaymentOrder(normalized, tx);
    const existingEvent = await loadAndValidatePaymentEvent(
      normalized,
      order,
      PaymentProviderEventType.RECHARGE_PAID,
      tx,
    );
    const fulfillmentKey = `service-payment:${encodeURIComponent(order.id)}:fulfill`;
    const grantKey = `service-entitlement:payment:${encodeURIComponent(order.id)}:grant`;

    if (order.status === RechargeOrderStatus.PAID) {
      return serializeCompletedPayment(
        order,
        existingEvent,
        await loadRequiredPaymentLedger(grantKey, tx),
        tx,
      );
    }
    if (
      order.status !== RechargeOrderStatus.CREATED &&
      order.status !== RechargeOrderStatus.REQUIRES_PAYMENT
    ) {
      throw new ServiceEntitlementError(
        "PAYMENT_STATE",
        `Service payment order cannot be fulfilled from status ${order.status}.`,
      );
    }

    const claimed = await tx.servicePaymentOrder.updateMany({
      where: {
        id: order.id,
        status: {
          in: [RechargeOrderStatus.CREATED, RechargeOrderStatus.REQUIRES_PAYMENT],
        },
        fulfillmentKey: null,
      },
      data: {
        status: RechargeOrderStatus.PAID,
        fulfillmentKey,
        paidAt: normalized.verifiedAt,
      },
    });
    if (claimed.count !== 1) {
      throw new ServiceEntitlementError(
        "PAYMENT_STATE",
        "Service payment order was fulfilled concurrently.",
      );
    }

    const paymentEvent =
      existingEvent ??
      (await tx.servicePaymentEvent.create({
        data: {
          paymentOrderId: order.id,
          provider: normalized.provider,
          providerAccountId: normalized.providerAccountId,
          providerEventId: normalized.providerEventId,
          eventType: PaymentProviderEventType.RECHARGE_PAID,
          verifiedAt: normalized.verifiedAt,
          rawPayload: normalized.rawPayload,
          ...(normalized.normalizedPayload === undefined
            ? {}
            : { normalizedPayload: normalized.normalizedPayload }),
        },
      }));

    const entitlement = await grantWithinTransaction(
      {
        audienceIdentityId: order.payerAudienceIdentityId,
        representativeId: order.representativeId,
        productCode: order.productCode,
        units: order.entitlementUnits,
        unitName: "credit",
        expiresAt: null,
        operationKey: `payment:${order.id}`,
        generationRunId: undefined,
        idempotencyKey: grantKey,
        paymentOrderId: order.id,
        notes: `payment_fulfillment:${order.provider}`,
        metadata: {
          provider: order.provider,
          providerAccountId: order.providerAccountId,
          providerOrderId: order.providerOrderId,
          amountMinor: order.amountMinor,
          currency: order.currency,
        },
      },
      tx,
    );

    const processedEvent = await tx.servicePaymentEvent.update({
      where: { id: paymentEvent.id },
      data: { processedAt: new Date() },
    });

    return {
      paymentOrderId: order.id,
      paymentEventId: processedEvent.id,
      paymentStatus: "PAID",
      provider: order.provider,
      providerOrderId: normalized.providerOrderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      entitlement,
    };
  });
}

/**
 * Applies a full provider-confirmed refund to the exact original order. It
 * never converts payment rails: an XTR order must be refunded by
 * TELEGRAM_STARS, while fiat orders must be refunded by their original fiat
 * provider. Already consumed or reserved units cannot make the account
 * negative, so the refund is rejected when insufficient available units
 * remain.
 */
export async function refundServiceEntitlement(
  input: ServicePaymentEvidenceInput,
  client: ServiceEntitlementClient = prisma as unknown as ServiceEntitlementClient,
): Promise<ServicePaymentFulfillmentSnapshot> {
  const normalized = normalizePaymentEvidence(input);
  return runAtomically(client, async (tx) => {
    const order = await loadAndValidatePaymentOrder(normalized, tx);
    const existingEvent = await loadAndValidatePaymentEvent(
      normalized,
      order,
      PaymentProviderEventType.REFUND_SUCCEEDED,
      tx,
    );
    const grantKey = `service-entitlement:payment:${encodeURIComponent(order.id)}:grant`;
    const refundKey = `service-entitlement:payment:${encodeURIComponent(order.id)}:refund`;
    const grantEntry = await loadRequiredPaymentLedger(grantKey, tx);

    if (order.status === RechargeOrderStatus.REFUNDED) {
      const refundEntry = await loadRequiredPaymentLedger(refundKey, tx);
      return serializeCompletedPayment(order, existingEvent, refundEntry, tx);
    }
    if (order.status !== RechargeOrderStatus.PAID) {
      throw new ServiceEntitlementError(
        "PAYMENT_STATE",
        `Service payment order cannot be refunded from status ${order.status}.`,
      );
    }

    const claimed = await tx.servicePaymentOrder.updateMany({
      where: {
        id: order.id,
        status: RechargeOrderStatus.PAID,
        refundedAt: null,
      },
      data: {
        status: RechargeOrderStatus.REFUNDED,
        refundedAt: normalized.verifiedAt,
      },
    });
    if (claimed.count !== 1) {
      throw new ServiceEntitlementError(
        "PAYMENT_STATE",
        "Service payment order was refunded concurrently.",
      );
    }

    const paymentEvent =
      existingEvent ??
      (await tx.servicePaymentEvent.create({
        data: {
          paymentOrderId: order.id,
          provider: normalized.provider,
          providerAccountId: normalized.providerAccountId,
          providerEventId: normalized.providerEventId,
          eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
          verifiedAt: normalized.verifiedAt,
          rawPayload: normalized.rawPayload,
          ...(normalized.normalizedPayload === undefined
            ? {}
            : { normalizedPayload: normalized.normalizedPayload }),
        },
      }));

    const account = await tx.serviceEntitlementAccount.findUnique({
      where: { id: grantEntry.entitlementAccountId },
    });
    if (!account) {
      throw new ServiceEntitlementError(
        "INVARIANT_VIOLATION",
        "The fulfilled payment entitlement account no longer exists.",
      );
    }

    const debited = await tx.serviceEntitlementAccount.updateMany({
      where: {
        id: account.id,
        remainingUnits: { gte: order.entitlementUnits },
      },
      data: {
        remainingUnits: { decrement: order.entitlementUnits },
      },
    });
    if (debited.count !== 1) {
      throw new ServiceEntitlementError(
        "INSUFFICIENT_UNITS",
        "Payment refund requires all granted units to remain available.",
      );
    }

    let updatedAccount = await requireAccountById(account.id, tx);
    if (
      updatedAccount.remainingUnits === 0 &&
      updatedAccount.reservedUnits === 0 &&
      updatedAccount.status !== ENTITLEMENT_STATUSES.FROZEN
    ) {
      updatedAccount = await tx.serviceEntitlementAccount.update({
        where: { id: account.id },
        data: { status: ENTITLEMENT_STATUSES.EXHAUSTED },
      });
    }

    const refundEntry = await tx.serviceEntitlementLedgerEntry.create({
      data: {
        entitlementAccountId: account.id,
        paymentOrderId: order.id,
        kind: LEDGER_KINDS.REFUND,
        units: order.entitlementUnits,
        balanceAfter: updatedAccount.remainingUnits,
        reservedAfter: updatedAccount.reservedUnits,
        idempotencyKey: refundKey,
        notes: `payment_refund:${order.provider}`,
        metadata: {
          provider: order.provider,
          providerAccountId: order.providerAccountId,
          providerOrderId: order.providerOrderId,
          amountMinor: order.amountMinor,
          currency: order.currency,
        },
      },
    });
    const processedEvent = await tx.servicePaymentEvent.update({
      where: { id: paymentEvent.id },
      data: { processedAt: new Date() },
    });

    return {
      paymentOrderId: order.id,
      paymentEventId: processedEvent.id,
      paymentStatus: "REFUNDED",
      provider: order.provider,
      providerOrderId: normalized.providerOrderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      entitlement: serializeEntitlement(updatedAccount, refundEntry),
    };
  });
}

export const refundServicePaymentOrder = refundServiceEntitlement;

async function grantWithinTransaction(
  input: ReturnType<typeof normalizeGrantInput> & {
    idempotencyKey: string;
    paymentOrderId?: string;
  },
  tx: ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const existing = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    return serializeExistingMutation(
      existing,
      LEDGER_KINDS.GRANT,
      input.units,
      input,
      tx,
    );
  }

  const account = await tx.serviceEntitlementAccount.upsert({
    where: {
      audienceIdentityId_representativeId_productCode: {
        audienceIdentityId: input.audienceIdentityId,
        representativeId: input.representativeId,
        productCode: input.productCode,
      },
    },
    create: {
      audienceIdentityId: input.audienceIdentityId,
      representativeId: input.representativeId,
      productCode: input.productCode,
      unitName: input.unitName,
      status: ENTITLEMENT_STATUSES.ACTIVE,
      grantedUnits: 0,
      remainingUnits: 0,
      reservedUnits: 0,
      expiresAt: input.expiresAt,
    },
    update: {},
  });
  if (account.unitName !== input.unitName) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      `Entitlement unitName does not match existing account unit ${account.unitName}.`,
    );
  }

  const granted = await tx.serviceEntitlementAccount.updateMany({
    where: {
      id: account.id,
      status: {
        in: [
          ENTITLEMENT_STATUSES.ACTIVE,
          ENTITLEMENT_STATUSES.EXHAUSTED,
          ENTITLEMENT_STATUSES.EXPIRED,
        ],
      },
    },
    data: {
      status: ENTITLEMENT_STATUSES.ACTIVE,
      grantedUnits: { increment: input.units },
      remainingUnits: { increment: input.units },
      expiresAt: input.expiresAt,
    },
  });
  if (granted.count !== 1) {
    throw new ServiceEntitlementError(
      "ACCOUNT_UNAVAILABLE",
      "Frozen entitlement accounts cannot receive grants.",
    );
  }

  const updatedAccount = await requireAccountById(account.id, tx);
  const entry = await tx.serviceEntitlementLedgerEntry.create({
    data: {
      entitlementAccountId: account.id,
      ...(input.paymentOrderId ? { paymentOrderId: input.paymentOrderId } : {}),
      ...(input.generationRunId ? { generationRunId: input.generationRunId } : {}),
      kind: LEDGER_KINDS.GRANT,
      units: input.units,
      balanceAfter: updatedAccount.remainingUnits,
      reservedAfter: updatedAccount.reservedUnits,
      idempotencyKey: input.idempotencyKey,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });
  return serializeEntitlement(updatedAccount, entry);
}

async function moveAvailableToReserved(
  input: ReturnType<typeof normalizeUnitMutationInput>,
  idempotencyKey: string,
  tx: ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const existing = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return serializeExistingMutation(
      existing,
      LEDGER_KINDS.RESERVE,
      input.units,
      input,
      tx,
    );
  }

  const account = await requireAccountByCoordinates(input, tx);
  const now = new Date();
  const moved = await tx.serviceEntitlementAccount.updateMany({
    where: {
      id: account.id,
      status: ENTITLEMENT_STATUSES.ACTIVE,
      remainingUnits: { gte: input.units },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: {
      remainingUnits: { decrement: input.units },
      reservedUnits: { increment: input.units },
    },
  });
  if (moved.count !== 1) {
    throwMutationFailure(account, input.units, "available");
  }

  const updatedAccount = await requireAccountById(account.id, tx);
  const entry = await createMutationLedger(
    updatedAccount,
    LEDGER_KINDS.RESERVE,
    input,
    idempotencyKey,
    tx,
  );
  return serializeEntitlement(updatedAccount, entry);
}

async function consumeReserved(
  input: ReturnType<typeof normalizeUnitMutationInput>,
  idempotencyKey: string,
  tx: ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const existing = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return serializeExistingMutation(
      existing,
      LEDGER_KINDS.CONSUME,
      input.units,
      input,
      tx,
    );
  }

  const account = await requireAccountByCoordinates(input, tx);
  const now = new Date();
  const consumed = await tx.serviceEntitlementAccount.updateMany({
    where: {
      id: account.id,
      status: ENTITLEMENT_STATUSES.ACTIVE,
      reservedUnits: { gte: input.units },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: {
      reservedUnits: { decrement: input.units },
    },
  });
  if (consumed.count !== 1) {
    throwMutationFailure(account, input.units, "reserved");
  }

  let updatedAccount = await requireAccountById(account.id, tx);
  if (updatedAccount.remainingUnits === 0 && updatedAccount.reservedUnits === 0) {
    updatedAccount = await tx.serviceEntitlementAccount.update({
      where: { id: account.id },
      data: { status: ENTITLEMENT_STATUSES.EXHAUSTED },
    });
  }
  const entry = await createMutationLedger(
    updatedAccount,
    LEDGER_KINDS.CONSUME,
    input,
    idempotencyKey,
    tx,
  );
  return serializeEntitlement(updatedAccount, entry);
}

async function releaseReserved(
  input: ReturnType<typeof normalizeUnitMutationInput>,
  idempotencyKey: string,
  tx: ServiceEntitlementClient,
): Promise<ServiceEntitlementSnapshot> {
  const existing = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return serializeExistingMutation(
      existing,
      LEDGER_KINDS.RELEASE,
      input.units,
      input,
      tx,
    );
  }

  const account = await requireAccountByCoordinates(input, tx);
  const released = await tx.serviceEntitlementAccount.updateMany({
    where: {
      id: account.id,
      reservedUnits: { gte: input.units },
    },
    data: {
      remainingUnits: { increment: input.units },
      reservedUnits: { decrement: input.units },
    },
  });
  if (released.count !== 1) {
    throw new ServiceEntitlementError(
      "INSUFFICIENT_UNITS",
      "Insufficient reserved service entitlement units.",
    );
  }

  let updatedAccount = await requireAccountById(account.id, tx);
  const expired =
    updatedAccount.expiresAt !== null && updatedAccount.expiresAt.getTime() <= Date.now();
  if (
    updatedAccount.status !== ENTITLEMENT_STATUSES.FROZEN &&
    updatedAccount.status !== ENTITLEMENT_STATUSES.ACTIVE
  ) {
    updatedAccount = await tx.serviceEntitlementAccount.update({
      where: { id: account.id },
      data: {
        status: expired
          ? ENTITLEMENT_STATUSES.EXPIRED
          : ENTITLEMENT_STATUSES.ACTIVE,
      },
    });
  }
  const entry = await createMutationLedger(
    updatedAccount,
    LEDGER_KINDS.RELEASE,
    input,
    idempotencyKey,
    tx,
  );
  return serializeEntitlement(updatedAccount, entry);
}

async function createMutationLedger(
  account: EntitlementAccountRecord,
  kind: EntitlementLedgerKind,
  input: ReturnType<typeof normalizeUnitMutationInput>,
  idempotencyKey: string,
  tx: ServiceEntitlementClient,
) {
  return tx.serviceEntitlementLedgerEntry.create({
    data: {
      entitlementAccountId: account.id,
      ...(input.generationRunId ? { generationRunId: input.generationRunId } : {}),
      kind,
      units: input.units,
      balanceAfter: account.remainingUnits,
      reservedAfter: account.reservedUnits,
      idempotencyKey,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });
}

async function serializeExistingMutation(
  entry: EntitlementLedgerRecord,
  expectedKind: EntitlementLedgerKind,
  expectedUnits: number,
  expectedCoordinates: ServiceEntitlementCoordinates,
  tx: ServiceEntitlementClient,
) {
  const account = await requireAccountById(entry.entitlementAccountId, tx);
  if (
    entry.kind !== expectedKind ||
    entry.units !== expectedUnits ||
    account.audienceIdentityId !== expectedCoordinates.audienceIdentityId ||
    account.representativeId !== expectedCoordinates.representativeId ||
    account.productCode !== expectedCoordinates.productCode
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "Entitlement operation key was reused with different immutable input.",
    );
  }
  return serializeEntitlement(account, entry);
}

async function requireAccountByCoordinates(
  coordinates: ServiceEntitlementCoordinates,
  tx: ServiceEntitlementClient,
) {
  const account = await tx.serviceEntitlementAccount.findUnique({
    where: {
      audienceIdentityId_representativeId_productCode: {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        productCode: coordinates.productCode,
      },
    },
  });
  if (!account) {
    throw new ServiceEntitlementError(
      "ACCOUNT_NOT_FOUND",
      "Service entitlement account not found.",
    );
  }
  return account;
}

async function requireAccountById(
  id: string,
  tx: ServiceEntitlementClient,
) {
  const account = await tx.serviceEntitlementAccount.findUnique({
    where: { id },
  });
  if (!account) {
    throw new ServiceEntitlementError(
      "ACCOUNT_NOT_FOUND",
      "Service entitlement account not found.",
    );
  }
  return account;
}

function throwMutationFailure(
  account: EntitlementAccountRecord,
  units: number,
  balance: "available" | "reserved",
): never {
  if (account.status !== ENTITLEMENT_STATUSES.ACTIVE) {
    throw new ServiceEntitlementError(
      "ACCOUNT_UNAVAILABLE",
      `Service entitlement account is ${account.status.toLowerCase()}.`,
    );
  }
  if (account.expiresAt && account.expiresAt.getTime() <= Date.now()) {
    throw new ServiceEntitlementError(
      "ACCOUNT_UNAVAILABLE",
      "Service entitlement account has expired.",
    );
  }
  throw new ServiceEntitlementError(
    "INSUFFICIENT_UNITS",
    `Insufficient ${balance} service entitlement units for ${units}.`,
  );
}

async function loadAndValidatePaymentOrder(
  input: ReturnType<typeof normalizePaymentEvidence>,
  tx: ServiceEntitlementClient,
) {
  const order = await tx.servicePaymentOrder.findUnique({
    where: { id: input.paymentOrderId },
  });
  if (!order) {
    throw new ServiceEntitlementError(
      "PAYMENT_NOT_FOUND",
      "Service payment order not found.",
    );
  }

  const expectedProviderOrderKey = servicePaymentProviderOrderKey(input);
  const mismatches = [
    order.provider !== input.provider ? "provider" : null,
    order.providerAccountId !== input.providerAccountId ? "providerAccountId" : null,
    order.providerOrderId !== input.providerOrderId ? "providerOrderId" : null,
    order.providerOrderKey && order.providerOrderKey !== expectedProviderOrderKey
      ? "providerOrderKey"
      : null,
    order.amountMinor !== input.amountMinor ? "amountMinor" : null,
    order.currency.toUpperCase() !== input.currency ? "currency" : null,
    order.payerAudienceIdentityId !== input.payerAudienceIdentityId
      ? "payerAudienceIdentityId"
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new ServiceEntitlementError(
      "PAYMENT_MISMATCH",
      `Service payment evidence does not match order: ${mismatches.join(", ")}.`,
    );
  }
  positiveInteger(order.entitlementUnits, "payment order entitlementUnits");
  requiredText(order.productCode, "payment order productCode");
  requiredText(order.representativeId, "payment order representativeId");
  assertPaymentRail(order.provider, order.currency);
  return order;
}

async function loadAndValidatePaymentEvent(
  input: ReturnType<typeof normalizePaymentEvidence>,
  order: ServicePaymentOrderRecord,
  expectedType: PaymentProviderEventType,
  tx: ServiceEntitlementClient,
) {
  const event = await tx.servicePaymentEvent.findUnique({
    where: {
      provider_providerAccountId_providerEventId: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        providerEventId: input.providerEventId,
      },
    },
  });
  if (event && event.paymentOrderId !== order.id) {
    throw new ServiceEntitlementError(
      "PAYMENT_MISMATCH",
      "Provider event is already attached to another service payment order.",
    );
  }
  if (event && event.eventType !== expectedType) {
    throw new ServiceEntitlementError(
      "PAYMENT_MISMATCH",
      "Provider event id was reused for a different payment event type.",
    );
  }
  return event;
}

async function loadRequiredPaymentLedger(
  idempotencyKey: string,
  tx: ServiceEntitlementClient,
) {
  const entry = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey },
  });
  if (!entry) {
    throw new ServiceEntitlementError(
      "INVARIANT_VIOLATION",
      "Completed service payment is missing its entitlement ledger entry.",
    );
  }
  return entry;
}

async function serializeCompletedPayment(
  order: ServicePaymentOrderRecord,
  paymentEvent: ServicePaymentEventRecord | null,
  ledger: EntitlementLedgerRecord,
  tx: ServiceEntitlementClient,
): Promise<ServicePaymentFulfillmentSnapshot> {
  const account = await requireAccountById(ledger.entitlementAccountId, tx);
  return {
    paymentOrderId: order.id,
    paymentEventId: paymentEvent?.id ?? null,
    paymentStatus:
      order.status === RechargeOrderStatus.REFUNDED ? "REFUNDED" : "PAID",
    provider: order.provider,
    providerOrderId: order.providerOrderId!,
    amountMinor: order.amountMinor,
    currency: order.currency,
    entitlement: serializeEntitlement(account, ledger),
  };
}

function serializeEntitlement(
  account: EntitlementAccountRecord,
  entry: EntitlementLedgerRecord,
): ServiceEntitlementSnapshot {
  return {
    accountId: account.id,
    audienceIdentityId: account.audienceIdentityId,
    representativeId: account.representativeId,
    productCode: account.productCode,
    unitName: account.unitName,
    status: account.status,
    grantedUnits: account.grantedUnits,
    remainingUnits: account.remainingUnits,
    reservedUnits: account.reservedUnits,
    expiresAt: account.expiresAt?.toISOString() ?? null,
    ledgerEntryId: entry.id,
    ledgerKind: entry.kind,
    units: entry.units,
    idempotencyKey: entry.idempotencyKey,
  };
}

type NormalizedCreateServicePaymentOrderInput = {
  id: string;
  payerAudienceIdentityId: string;
  representativeId: string;
  provider: PaymentProvider;
  providerAccountId: string;
  providerOrderId: string;
  providerOrderKey: string;
  productCode: string;
  amountMinor: number;
  currency: string;
  entitlementUnits: number;
  priceSnapshot: unknown;
  checkoutUrl: string | undefined;
  providerPayload: unknown | undefined;
  status: "CREATED" | "REQUIRES_PAYMENT";
};

function normalizeCreatePaymentOrderInput(
  input: CreateServicePaymentOrderInput,
): NormalizedCreateServicePaymentOrderInput {
  const providerAccountId = requiredText(
    input.providerAccountId,
    "providerAccountId",
  );
  const providerOrderId = requiredText(input.providerOrderId, "providerOrderId");
  const currency = requiredText(input.currency, "currency").toUpperCase();
  if (input.priceSnapshot === undefined || input.priceSnapshot === null) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "priceSnapshot is required for payment audit.",
    );
  }
  const status = input.status ?? RechargeOrderStatus.REQUIRES_PAYMENT;
  if (
    status !== RechargeOrderStatus.CREATED &&
    status !== RechargeOrderStatus.REQUIRES_PAYMENT
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "A new service payment order must start as CREATED or REQUIRES_PAYMENT.",
    );
  }

  const normalized = {
    id: requiredText(input.id, "id"),
    payerAudienceIdentityId: requiredText(
      input.payerAudienceIdentityId,
      "payerAudienceIdentityId",
    ),
    representativeId: requiredText(input.representativeId, "representativeId"),
    provider: input.provider,
    providerAccountId,
    providerOrderId,
    providerOrderKey: servicePaymentProviderOrderKey({
      provider: input.provider,
      providerAccountId,
      providerOrderId,
    }),
    productCode: requiredText(input.productCode, "productCode"),
    amountMinor: positiveInteger(input.amountMinor, "amountMinor"),
    currency,
    entitlementUnits: positiveInteger(
      input.entitlementUnits,
      "entitlementUnits",
    ),
    priceSnapshot: normalizeJsonAuditValue(input.priceSnapshot, "priceSnapshot"),
    checkoutUrl: optionalText(input.checkoutUrl),
    providerPayload:
      input.providerPayload === undefined
        ? undefined
        : normalizeJsonAuditValue(input.providerPayload, "providerPayload"),
    status,
  };
  assertPaymentRail(normalized.provider, normalized.currency);
  return normalized;
}

function assertSameServicePaymentOrder(
  order: ServicePaymentOrderRecord,
  input: NormalizedCreateServicePaymentOrderInput,
) {
  const mismatches = [
    order.id !== input.id ? "id" : null,
    order.payerAudienceIdentityId !== input.payerAudienceIdentityId
      ? "payerAudienceIdentityId"
      : null,
    order.representativeId !== input.representativeId ? "representativeId" : null,
    order.provider !== input.provider ? "provider" : null,
    order.providerAccountId !== input.providerAccountId ? "providerAccountId" : null,
    order.providerOrderId !== input.providerOrderId ? "providerOrderId" : null,
    order.providerOrderKey !== input.providerOrderKey ? "providerOrderKey" : null,
    order.productCode !== input.productCode ? "productCode" : null,
    order.amountMinor !== input.amountMinor ? "amountMinor" : null,
    order.currency.toUpperCase() !== input.currency ? "currency" : null,
    order.entitlementUnits !== input.entitlementUnits ? "entitlementUnits" : null,
    !sameJsonValue(order.priceSnapshot, input.priceSnapshot)
      ? "priceSnapshot"
      : null,
    order.checkoutUrl !== (input.checkoutUrl ?? null) ? "checkoutUrl" : null,
    !sameJsonValue(order.providerPayload, input.providerPayload ?? null)
      ? "providerPayload"
      : null,
  ].filter((value): value is string => value !== null);

  if (mismatches.length > 0) {
    throw new ServiceEntitlementError(
      "PAYMENT_MISMATCH",
      `Service payment order key was reused with different immutable input: ${mismatches.join(", ")}.`,
    );
  }
}

type ConversationEntitlementAttempt = {
  attempt: number;
  reserve: EntitlementLedgerRecord;
  consume?: EntitlementLedgerRecord;
  release?: EntitlementLedgerRecord;
};

function normalizeConversationProductCodes(productCodes?: string[]) {
  const normalized = Array.from(
    new Set(
      (productCodes ?? ["plan:deep_help", "plan:pass"]).map((productCode) =>
        requiredText(productCode, "productCode"),
      ),
    ),
  );
  if (normalized.length === 0) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "At least one conversation entitlement product code is required.",
    );
  }
  return normalized;
}

function conversationEntitlementAttemptKey(
  generationRunId: string,
  attempt: number,
) {
  return `generation:${requiredText(generationRunId, "generationRunId")}:attempt:${positiveInteger(attempt, "attempt")}`;
}

function conversationEntitlementLedgerKey(
  action: "reserve" | "consume" | "release",
  generationRunId: string,
  attempt: number,
) {
  return [
    "conversation-entitlement",
    encodeKeyPart(generationRunId, "generationRunId"),
    positiveInteger(attempt, "attempt"),
    action,
  ].join(":");
}

async function loadConversationEntitlementHistory(
  generationRunId: string,
  tx: ServiceEntitlementClient,
): Promise<ConversationEntitlementAttempt[]> {
  const entries = await tx.serviceEntitlementLedgerEntry.findMany({
    where: {
      generationRunId,
      kind: {
        in: [
          LEDGER_KINDS.RESERVE,
          LEDGER_KINDS.CONSUME,
          LEDGER_KINDS.RELEASE,
        ],
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const pattern = new RegExp(
    `^conversation-entitlement:${escapeRegExp(
      encodeURIComponent(generationRunId),
    )}:(\\d+):(reserve|consume|release)$`,
  );
  const attempts = new Map<number, ConversationEntitlementAttempt>();

  for (const entry of entries) {
    const match = pattern.exec(entry.idempotencyKey);
    if (!match) {
      throw new ServiceEntitlementError(
        "INVARIANT_VIOLATION",
        "Generation run contains an unsupported legacy conversation entitlement reservation.",
      );
    }
    const attempt = Number(match[1]);
    const action = match[2] as "reserve" | "consume" | "release";
    positiveInteger(attempt, "conversation entitlement attempt");
    const expectedKind =
      action === "reserve"
        ? LEDGER_KINDS.RESERVE
        : action === "consume"
          ? LEDGER_KINDS.CONSUME
          : LEDGER_KINDS.RELEASE;
    if (
      entry.kind !== expectedKind ||
      entry.units !== 1 ||
      entry.generationRunId !== generationRunId
    ) {
      throw new ServiceEntitlementError(
        "INVARIANT_VIOLATION",
        "Conversation entitlement ledger entry does not match its immutable key.",
      );
    }

    const current = attempts.get(attempt);
    if (action === "reserve") {
      if (current?.reserve) {
        throw new ServiceEntitlementError(
          "INVARIANT_VIOLATION",
          "Conversation entitlement attempt contains duplicate reservations.",
        );
      }
      attempts.set(attempt, {
        ...(current ?? ({} as ConversationEntitlementAttempt)),
        attempt,
        reserve: entry,
      });
    } else {
      const next = current ?? ({} as ConversationEntitlementAttempt);
      if (next[action]) {
        throw new ServiceEntitlementError(
          "INVARIANT_VIOLATION",
          `Conversation entitlement attempt contains duplicate ${action} entries.`,
        );
      }
      attempts.set(attempt, {
        ...next,
        attempt,
        [action]: entry,
      });
    }
  }

  const result = [...attempts.values()].sort((left, right) => left.attempt - right.attempt);
  for (const attempt of result) {
    if (!attempt.reserve || (attempt.consume && attempt.release)) {
      throw new ServiceEntitlementError(
        "INVARIANT_VIOLATION",
        "Conversation entitlement attempt has an invalid lifecycle.",
      );
    }
  }
  return result;
}

function latestConversationEntitlementAttempt(
  history: ConversationEntitlementAttempt[],
) {
  return history.at(-1);
}

async function resolveEntitlementAudienceIdentityId(
  audienceIdentityId: string,
  client: ServiceEntitlementClient,
) {
  const initialId = requiredText(audienceIdentityId, "audienceIdentityId");
  if (!client.audienceIdentity) return initialId;

  const visited = new Set<string>();
  let currentId = initialId;
  for (let depth = 0; depth < 16; depth += 1) {
    if (visited.has(currentId)) {
      throw new ServiceEntitlementError(
        "INVARIANT_VIOLATION",
        "Audience identity merge chain contains a cycle.",
      );
    }
    visited.add(currentId);
    const identity = await client.audienceIdentity.findUnique({
      where: { id: currentId },
      select: { id: true, status: true, mergedIntoId: true },
    });
    if (!identity) {
      throw new ServiceEntitlementError(
        "INVALID_INPUT",
        "Audience identity was not found.",
      );
    }
    if (identity.status === "DISABLED") {
      throw new ServiceEntitlementError(
        "ACCOUNT_UNAVAILABLE",
        "Audience identity is disabled.",
      );
    }
    if (identity.status !== "MERGED") return identity.id;
    currentId = requiredText(
      identity.mergedIntoId ?? "",
      "merged audience identity target",
    );
  }
  throw new ServiceEntitlementError(
    "INVARIANT_VIOLATION",
    "Audience identity merge chain exceeds the supported depth.",
  );
}

function assertConversationEntitlementAccount(
  account: EntitlementAccountRecord,
  representativeId: string,
  productCodes: string[],
) {
  if (
    account.representativeId !== representativeId ||
    !productCodes.includes(account.productCode)
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "Generation run entitlement history belongs to different immutable coordinates.",
    );
  }
}

function serializeConversationReservation(input: {
  account: EntitlementAccountRecord;
  generationRunId: string;
  attempt: number;
}): ConversationEntitlementReservation {
  return {
    audienceIdentityId: input.account.audienceIdentityId,
    representativeId: input.account.representativeId,
    productCode: input.account.productCode,
    generationRunId: input.generationRunId,
    operationKey: conversationEntitlementAttemptKey(
      input.generationRunId,
      input.attempt,
    ),
    accountId: input.account.id,
    attempt: input.attempt,
  };
}

function normalizeConversationReservation(
  reservation: ConversationEntitlementReservation,
) {
  const attempt = positiveInteger(reservation.attempt, "attempt");
  const generationRunId = requiredText(
    reservation.generationRunId,
    "generationRunId",
  );
  const operationKey = requiredText(reservation.operationKey, "operationKey");
  if (operationKey !== conversationEntitlementAttemptKey(generationRunId, attempt)) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "Conversation entitlement reservation operation key is invalid.",
    );
  }
  return {
    audienceIdentityId: requiredText(
      reservation.audienceIdentityId,
      "audienceIdentityId",
    ),
    representativeId: requiredText(
      reservation.representativeId,
      "representativeId",
    ),
    productCode: requiredText(reservation.productCode, "productCode"),
    generationRunId,
    operationKey,
    accountId: requiredText(reservation.accountId, "accountId"),
    attempt,
  };
}

async function releaseConversationReservationInTransaction(
  normalized: ReturnType<typeof normalizeConversationReservation>,
  tx: ServiceEntitlementClient,
  notes = "Released because the conversation reply did not complete.",
) {
  const reserveEntry = await requireConversationReserveEntry(normalized, tx);
  const releaseKey = conversationEntitlementLedgerKey(
    "release",
    normalized.generationRunId,
    normalized.attempt,
  );
  const consumeKey = conversationEntitlementLedgerKey(
    "consume",
    normalized.generationRunId,
    normalized.attempt,
  );
  const existingRelease = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey: releaseKey },
  });
  if (existingRelease) {
    return serializeExistingConversationMutation(
      existingRelease,
      LEDGER_KINDS.RELEASE,
      normalized,
      tx,
    );
  }
  if (
    await tx.serviceEntitlementLedgerEntry.findUnique({
      where: { idempotencyKey: consumeKey },
    })
  ) {
    throw new ServiceEntitlementError(
      "ACCOUNT_UNAVAILABLE",
      "Conversation entitlement reservation was already consumed.",
    );
  }

  const account = await requireAccountById(reserveEntry.entitlementAccountId, tx);
  assertConversationReservationAccount(account, normalized);
  return releaseReserved(
    normalizeUnitMutationInput({
      audienceIdentityId: account.audienceIdentityId,
      representativeId: account.representativeId,
      productCode: account.productCode,
      units: 1,
      operationKey: normalized.operationKey,
      generationRunId: normalized.generationRunId,
      notes,
      metadata: {
        scope: "conversation_reply",
        reservationAttempt: normalized.attempt,
      },
    }),
    releaseKey,
    tx,
  );
}

async function requireConversationReserveEntry(
  reservation: ReturnType<typeof normalizeConversationReservation>,
  tx: ServiceEntitlementClient,
) {
  const entry = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: {
      idempotencyKey: conversationEntitlementLedgerKey(
        "reserve",
        reservation.generationRunId,
        reservation.attempt,
      ),
    },
  });
  if (
    !entry ||
    entry.kind !== LEDGER_KINDS.RESERVE ||
    entry.units !== 1 ||
    entry.generationRunId !== reservation.generationRunId ||
    entry.entitlementAccountId !== reservation.accountId
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "Conversation entitlement reservation handle is invalid.",
    );
  }
  return entry;
}

function assertConversationReservationAccount(
  account: EntitlementAccountRecord,
  reservation: ReturnType<typeof normalizeConversationReservation>,
) {
  if (
    account.id !== reservation.accountId ||
    account.representativeId !== reservation.representativeId ||
    account.productCode !== reservation.productCode
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "Conversation entitlement account no longer matches the reservation handle.",
    );
  }
}

async function serializeExistingConversationMutation(
  entry: EntitlementLedgerRecord,
  expectedKind: EntitlementLedgerKind,
  reservation: ReturnType<typeof normalizeConversationReservation>,
  tx: ServiceEntitlementClient,
) {
  if (
    entry.kind !== expectedKind ||
    entry.units !== 1 ||
    entry.generationRunId !== reservation.generationRunId ||
    entry.entitlementAccountId !== reservation.accountId
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "Conversation entitlement mutation key was reused with different immutable input.",
    );
  }
  const account = await requireAccountById(entry.entitlementAccountId, tx);
  assertConversationReservationAccount(account, reservation);
  return serializeEntitlement(account, entry);
}

function isSkippableConversationEntitlementError(error: unknown) {
  return (
    error instanceof ServiceEntitlementError &&
    (error.code === "ACCOUNT_NOT_FOUND" ||
      error.code === "ACCOUNT_UNAVAILABLE" ||
      error.code === "INSUFFICIENT_UNITS")
  );
}

function normalizeGrantInput(input: GrantServiceEntitlementInput) {
  const common = normalizeUnitMutationInput(input);
  const unitName = requiredText(input.unitName ?? "credit", "unitName");
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "expiresAt must be a valid date.",
    );
  }
  return {
    ...common,
    unitName,
    expiresAt,
  };
}

function normalizeUnitMutationInput(
  input:
    | GrantServiceEntitlementInput
    | ReserveServiceEntitlementInput
    | ConsumeServiceEntitlementInput
    | ReleaseServiceEntitlementInput,
) {
  return {
    audienceIdentityId: requiredText(
      input.audienceIdentityId,
      "audienceIdentityId",
    ),
    representativeId: requiredText(input.representativeId, "representativeId"),
    productCode: requiredText(input.productCode, "productCode"),
    units: positiveInteger(input.units, "units"),
    operationKey: requiredText(input.operationKey, "operationKey"),
    generationRunId: optionalText(input.generationRunId),
    notes: optionalText(input.notes),
    metadata: input.metadata,
  };
}

function normalizePaymentEvidence(input: ServicePaymentEvidenceInput) {
  const currency = requiredText(input.currency, "currency").toUpperCase();
  if (input.rawPayload === undefined || input.rawPayload === null) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "rawPayload is required for payment audit.",
    );
  }
  if (
    !(input.verifiedAt instanceof Date) ||
    Number.isNaN(input.verifiedAt.getTime())
  ) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      "verifiedAt must be a valid date from a verified provider event.",
    );
  }
  const normalized = {
    paymentOrderId: requiredText(input.paymentOrderId, "paymentOrderId"),
    provider: input.provider,
    providerAccountId: requiredText(input.providerAccountId, "providerAccountId"),
    providerOrderId: requiredText(input.providerOrderId, "providerOrderId"),
    providerEventId: requiredText(input.providerEventId, "providerEventId"),
    payerAudienceIdentityId: requiredText(
      input.payerAudienceIdentityId,
      "payerAudienceIdentityId",
    ),
    amountMinor: positiveInteger(input.amountMinor, "amountMinor"),
    currency,
    verifiedAt: input.verifiedAt,
    rawPayload: input.rawPayload,
    normalizedPayload: input.normalizedPayload,
  };
  assertPaymentRail(normalized.provider, normalized.currency);
  return normalized;
}

function assertPaymentRail(provider: PaymentProvider, currency: string) {
  const normalizedCurrency = currency.toUpperCase();
  if (
    provider === PaymentProvider.TELEGRAM_STARS &&
    normalizedCurrency !== "XTR"
  ) {
    throw new ServiceEntitlementError(
      "PAYMENT_MISMATCH",
      "Telegram Stars service payments must use XTR.",
    );
  }
  if (
    provider !== PaymentProvider.TELEGRAM_STARS &&
    normalizedCurrency === "XTR"
  ) {
    throw new ServiceEntitlementError(
      "PAYMENT_MISMATCH",
      "XTR cannot be fulfilled or refunded by a fiat payment provider.",
    );
  }
}

function requiredText(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      `${name} is required.`,
    );
  }
  return normalized;
}

function optionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeJsonAuditValue(value: unknown, name: string): unknown {
  try {
    return normalizeJsonValue(value, new Set<object>());
  } catch {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      `${name} must be a JSON-compatible value.`,
    );
  }
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) {
    throw new Error("unsupported or cyclic JSON value");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJsonValue(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("non-plain JSON object");
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [
          key,
          normalizeJsonValue(item, ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function sameJsonValue(left: unknown, right: unknown) {
  try {
    return (
      JSON.stringify(normalizeJsonValue(left, new Set<object>())) ===
      JSON.stringify(normalizeJsonValue(right, new Set<object>()))
    );
  } catch {
    return false;
  }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceEntitlementError(
      "INVALID_INPUT",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function encodeKeyPart(value: string, name: string) {
  return encodeURIComponent(requiredText(value, name));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runAtomically<T>(
  client: ServiceEntitlementClient,
  operation: (tx: ServiceEntitlementClient) => Promise<T>,
) {
  if (!client.$transaction) {
    return operation(client);
  }
  for (let uniqueRaceAttempt = 0; uniqueRaceAttempt < 2; uniqueRaceAttempt += 1) {
    try {
      return await runWithPrismaWriteConflictRetry(() =>
        client.$transaction!(operation, { isolationLevel: "Serializable" }),
      );
    } catch (error) {
      if (
        uniqueRaceAttempt === 1 ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      // A concurrent transaction committed the same deterministic ledger/event
      // key. Re-run once so the normal idempotent read path returns its result.
    }
  }
  throw new ServiceEntitlementError(
    "INVARIANT_VIOLATION",
    "Entitlement transaction retry loop exhausted unexpectedly.",
  );
}
