import {
  PaymentProvider,
  Prisma,
  RechargeRefundProviderStatus,
  RechargeRefundReversalStatus,
  ReliableEventStatus,
  WalletExceptionActionType,
  WalletExceptionCaseStatus,
  WalletExceptionSeverity,
  WalletExceptionSourceType,
} from "@prisma/client";

import { WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE } from "./agent-wallet-wechat-refund-submission";
import { WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE } from "./agent-wallet-wechat-refunds";
import { prisma } from "./prisma";

const WECHAT_ORDER_RECONCILIATION_EVENT_TYPE =
  "wechat_pay.order.reconcile";

const OUTBOX_CASE_SPECS = {
  [WECHAT_ORDER_RECONCILIATION_EVENT_TYPE]: {
    sourceType:
      WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX,
    kind: "payment_reconciliation",
    reasonCode: "wechat_order_reconciliation_dead_letter",
    severity: WalletExceptionSeverity.CRITICAL,
    aggregate: "order",
    aggregateType: "recharge_order",
  },
  [WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE]: {
    sourceType:
      WalletExceptionSourceType.REFUND_LIFECYCLE_OUTBOX,
    kind: "refund_lifecycle",
    reasonCode: "wechat_refund_lifecycle_dead_letter",
    severity: WalletExceptionSeverity.CRITICAL,
    aggregate: "refund",
    aggregateType: "recharge_refund",
  },
  [WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE]: {
    sourceType:
      WalletExceptionSourceType.REFUND_REVERSAL_OUTBOX,
    kind: "refund_reversal",
    reasonCode: "wechat_refund_reversal_dead_letter",
    severity: WalletExceptionSeverity.CRITICAL,
    aggregate: "refund",
    aggregateType: "recharge_refund",
  },
} as const;

const OUTBOX_SOURCE_TYPES = [
  WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX,
  WalletExceptionSourceType.REFUND_LIFECYCLE_OUTBOX,
  WalletExceptionSourceType.REFUND_REVERSAL_OUTBOX,
] as const;

export type WalletExceptionCaseView = {
  id: string;
  kind: string;
  reasonCode: string;
  severity: "warning" | "error" | "critical";
  status: "open" | "claimed" | "acknowledged" | "resolved";
  version: number;
  representativeSlug: string;
  representativeName: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
  claimedByCurrentOwner: boolean;
};

export type WalletExceptionActionName =
  | "claim"
  | "retry"
  | "acknowledge";

export type ActOnWalletExceptionCaseInput = {
  caseId: string;
  ownerId: string;
  representativeSlug: string;
  action: WalletExceptionActionName;
  expectedVersion: number;
  idempotencyKey: string;
  note?: string;
};

export class WalletExceptionActionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(
    code: string,
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "WalletExceptionActionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function syncWeChatPayWalletExceptionCases(
  options: {
    client?: typeof prisma;
    now?: Date;
  } = {},
): Promise<{
  detected: number;
  resolved: number;
}> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const outboxes = await client.outboxEvent.findMany({
    where: {
      status: ReliableEventStatus.DEAD_LETTER,
      OR: Object.entries(OUTBOX_CASE_SPECS).map(
        ([eventType, spec]) => ({
          eventType,
          aggregateType: spec.aggregateType,
        }),
      ),
    },
    select: {
      id: true,
      eventType: true,
      aggregateType: true,
      aggregateId: true,
    },
  });
  const orderIds = outboxes
    .filter(
      (outbox) =>
        OUTBOX_CASE_SPECS[
          outbox.eventType as keyof typeof OUTBOX_CASE_SPECS
        ]?.aggregate === "order",
    )
    .map((outbox) => outbox.aggregateId);
  const refundIds = outboxes
    .filter(
      (outbox) =>
        OUTBOX_CASE_SPECS[
          outbox.eventType as keyof typeof OUTBOX_CASE_SPECS
        ]?.aggregate === "refund",
    )
    .map((outbox) => outbox.aggregateId);

  const [orders, refunds] = await Promise.all([
    orderIds.length > 0
      ? client.rechargeOrder.findMany({
          where: {
            id: { in: orderIds },
            provider: PaymentProvider.WECHAT_PAY,
          },
          select: {
            id: true,
            representativeId: true,
            currency: true,
            representative: {
              select: { ownerId: true },
            },
          },
        })
      : Promise.resolve([]),
    client.rechargeRefund.findMany({
      where: {
        provider: PaymentProvider.WECHAT_PAY,
        OR: [
          ...(refundIds.length > 0
            ? [{ id: { in: refundIds } }]
            : []),
          {
            reversalStatus:
              RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
          },
          {
            providerStatus:
              RechargeRefundProviderStatus.ABNORMAL,
          },
        ],
      },
      select: {
        id: true,
        currency: true,
        providerStatus: true,
        reversalStatus: true,
        rechargeOrder: {
          select: {
            representativeId: true,
            representative: {
              select: { ownerId: true },
            },
          },
        },
      },
    }),
  ]);

  const orderById = new Map(
    orders.map((order) => [order.id, order]),
  );
  const refundById = new Map(
    refunds.map((refund) => [refund.id, refund]),
  );
  const activeSources = new Set<string>();
  let detected = 0;

  for (const outbox of outboxes) {
    const spec =
      OUTBOX_CASE_SPECS[
        outbox.eventType as keyof typeof OUTBOX_CASE_SPECS
      ];
    if (!spec) continue;
    const scope =
      spec.aggregate === "order"
        ? ownerScopeFromOrder(orderById.get(outbox.aggregateId))
        : ownerScopeFromRefund(refundById.get(outbox.aggregateId));
    if (!scope) continue;
    await upsertDetectedCase(client, {
      ownerId: scope.ownerId,
      representativeId: scope.representativeId,
      currency: scope.currency,
      kind: spec.kind,
      reasonCode: spec.reasonCode,
      severity: spec.severity,
      sourceType: spec.sourceType,
      sourceId: outbox.id,
      outboxEventId: outbox.id,
      rechargeRefundId:
        spec.aggregate === "refund"
          ? outbox.aggregateId
          : null,
      now,
    });
    activeSources.add(sourceKey(spec.sourceType, outbox.id));
    detected += 1;
  }

  for (const refund of refunds) {
    const scope = ownerScopeFromRefund(refund);
    if (!scope) continue;
    if (
      refund.reversalStatus
      === RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
    ) {
      await upsertDetectedCase(client, {
        ...scope,
        kind: "refund_reconciliation",
        reasonCode: "wechat_refund_reconciliation_required",
        severity: WalletExceptionSeverity.CRITICAL,
        sourceType:
          WalletExceptionSourceType.REFUND_RECONCILIATION,
        sourceId: refund.id,
        outboxEventId: null,
        rechargeRefundId: refund.id,
        now,
      });
      activeSources.add(
        sourceKey(
          WalletExceptionSourceType.REFUND_RECONCILIATION,
          refund.id,
        ),
      );
      detected += 1;
    }
    if (
      refund.providerStatus
      === RechargeRefundProviderStatus.ABNORMAL
    ) {
      await upsertDetectedCase(client, {
        ...scope,
        kind: "refund_abnormal",
        reasonCode: "wechat_refund_abnormal",
        severity: WalletExceptionSeverity.ERROR,
        sourceType: WalletExceptionSourceType.REFUND_ABNORMAL,
        sourceId: refund.id,
        outboxEventId: null,
        rechargeRefundId: refund.id,
        now,
      });
      activeSources.add(
        sourceKey(
          WalletExceptionSourceType.REFUND_ABNORMAL,
          refund.id,
        ),
      );
      detected += 1;
    }
  }

  const activeCases = await client.walletExceptionCase.findMany({
    where: {
      sourceType: {
        in: [
          ...OUTBOX_SOURCE_TYPES,
          WalletExceptionSourceType.REFUND_RECONCILIATION,
          WalletExceptionSourceType.REFUND_ABNORMAL,
        ],
      },
      status: { not: WalletExceptionCaseStatus.RESOLVED },
    },
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      outboxEvent: {
        select: { status: true },
      },
      rechargeRefund: {
        select: {
          reversalStatus: true,
          providerStatus: true,
        },
      },
    },
  });
  let resolved = 0;
  for (const exceptionCase of activeCases) {
    if (
      activeSources.has(
        sourceKey(
          exceptionCase.sourceType,
          exceptionCase.sourceId,
        ),
      )
      || !sourceIsRecovered(exceptionCase)
    ) {
      continue;
    }
    const result = await client.walletExceptionCase.updateMany({
      where: {
        id: exceptionCase.id,
        status: { not: WalletExceptionCaseStatus.RESOLVED },
      },
      data: {
        status: WalletExceptionCaseStatus.RESOLVED,
        resolvedAt: now,
        version: { increment: 1 },
      },
    });
    resolved += result.count;
  }

  return { detected, resolved };
}

export async function listWalletExceptionCases(input: {
  ownerId: string;
  representativeSlug: string;
  client?: typeof prisma;
}): Promise<WalletExceptionCaseView[]> {
  const ownerId = requiredText(input.ownerId, "ownerId", 128);
  const representativeSlug = requiredText(
    input.representativeSlug,
    "representativeSlug",
    128,
  );
  const client = input.client ?? prisma;
  const representative = await client.representative.findFirst({
    where: {
      slug: representativeSlug,
      ownerId,
    },
    select: { id: true },
  });
  if (!representative) {
    throw new WalletExceptionActionError(
      "wallet_exception_not_found",
      "Wallet exception queue was not found.",
      404,
    );
  }
  const cases = await client.walletExceptionCase.findMany({
    where: {
      ownerId,
      status: { not: WalletExceptionCaseStatus.RESOLVED },
    },
    include: walletExceptionViewInclude,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return cases.map((exceptionCase) =>
    serializeWalletExceptionCase(exceptionCase, ownerId),
  );
}

export async function actOnWalletExceptionCase(
  input: ActOnWalletExceptionCaseInput,
  options: {
    client?: typeof prisma;
    now?: Date;
  } = {},
): Promise<WalletExceptionCaseView> {
  const caseId = requiredText(input.caseId, "caseId", 128);
  const ownerId = requiredText(input.ownerId, "ownerId", 128);
  const representativeSlug = requiredText(
    input.representativeSlug,
    "representativeSlug",
    128,
  );
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    "idempotencyKey",
    128,
  );
  if (
    !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0
  ) {
    throw new WalletExceptionActionError(
      "wallet_exception_action_invalid",
      "expectedVersion must be a non-negative integer.",
      400,
    );
  }
  const note = normalizedNote(input.note);
  if (input.action === "acknowledge" && !note) {
    throw new WalletExceptionActionError(
      "wallet_exception_note_required",
      "A note is required to acknowledge an exception.",
      400,
    );
  }
  const action = actionEnum(input.action);
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();

  const execute = () => client.$transaction(async (tx) => {
    const billingAnchor = await tx.representative.findFirst({
      where: {
        slug: representativeSlug,
        ownerId,
      },
      select: { id: true },
    });
    if (!billingAnchor) throw notFoundError();

    const replay = await tx.walletExceptionAction.findUnique({
      where: {
        actorOwnerId_idempotencyKey: {
          actorOwnerId: ownerId,
          idempotencyKey,
        },
      },
    });
    if (replay) {
      if (
        replay.caseId !== caseId
        || replay.action !== action
        || replay.expectedVersion !== input.expectedVersion
        || replay.note !== note
      ) {
        throw new WalletExceptionActionError(
          "wallet_exception_idempotency_conflict",
          "This action key belongs to another request.",
          409,
        );
      }
      const replayCase = await findOwnedCase(
        tx,
        caseId,
        ownerId,
      );
      if (!replayCase) {
        throw notFoundError();
      }
      return serializeWalletExceptionCase(
        replayCase,
        ownerId,
      );
    }

    const exceptionCase = await findOwnedCase(
      tx,
      caseId,
      ownerId,
    );
    if (!exceptionCase) throw notFoundError();
    if (
      exceptionCase.version !== input.expectedVersion
      || exceptionCase.status
        === WalletExceptionCaseStatus.RESOLVED
    ) {
      throw new WalletExceptionActionError(
        "wallet_exception_version_conflict",
        "The exception changed. Refresh before trying again.",
        409,
      );
    }
    await assertCurrentOwnerScope(
      tx,
      exceptionCase,
      ownerId,
    );
    assertActionTransition(exceptionCase, action, ownerId);

    if (action === WalletExceptionActionType.RETRY) {
      assertRetryableOutbox(exceptionCase);
      const reset = await tx.outboxEvent.updateMany({
        where: {
          id: exceptionCase.outboxEventId!,
          status: {
            in: [
              ReliableEventStatus.FAILED,
              ReliableEventStatus.DEAD_LETTER,
            ],
          },
        },
        data: {
          status: ReliableEventStatus.PENDING,
          attemptCount: 0,
          availableAt: now,
          processedAt: null,
          lastError: null,
        },
      });
      if (reset.count !== 1) {
        throw new WalletExceptionActionError(
          "wallet_exception_not_retryable",
          "The bound operation is no longer retryable.",
          409,
        );
      }
    }

    const update = actionCaseUpdate(action, ownerId, note, now);
    const changed = await tx.walletExceptionCase.updateMany({
      where: {
        id: exceptionCase.id,
        ownerId,
        representativeId: exceptionCase.representativeId,
        version: input.expectedVersion,
        status: { not: WalletExceptionCaseStatus.RESOLVED },
      },
      data: {
        ...update,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw new WalletExceptionActionError(
        "wallet_exception_version_conflict",
        "The exception changed. Refresh before trying again.",
        409,
      );
    }
    await tx.walletExceptionAction.create({
      data: {
        caseId: exceptionCase.id,
        actorOwnerId: ownerId,
        action,
        idempotencyKey,
        expectedVersion: input.expectedVersion,
        resultingVersion: input.expectedVersion + 1,
        note,
      },
    });
    const updated = await findOwnedCase(
      tx,
      caseId,
      ownerId,
    );
    if (!updated) throw notFoundError();
    return serializeWalletExceptionCase(updated, ownerId);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
  try {
    return await execute();
  } catch (error) {
    if (!isConcurrentActionConflict(error)) throw error;
    if (prismaErrorCode(error) === "P2034") {
      try {
        return await execute();
      } catch (retryError) {
        if (!isConcurrentActionConflict(retryError)) {
          throw retryError;
        }
      }
    }
    return resolveConcurrentActionConflict(client, {
      caseId,
      ownerId,
      representativeSlug,
      action,
      expectedVersion: input.expectedVersion,
      idempotencyKey,
      note,
    });
  }
}

async function resolveConcurrentActionConflict(
  client: typeof prisma,
  input: {
    caseId: string;
    ownerId: string;
    representativeSlug: string;
    action: WalletExceptionActionType;
    expectedVersion: number;
    idempotencyKey: string;
    note: string | null;
  },
): Promise<WalletExceptionCaseView> {
  const [billingAnchor, replay] = await Promise.all([
    client.representative.findFirst({
      where: {
        slug: input.representativeSlug,
        ownerId: input.ownerId,
      },
      select: { id: true },
    }),
    client.walletExceptionAction.findUnique({
      where: {
        actorOwnerId_idempotencyKey: {
          actorOwnerId: input.ownerId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    }),
  ]);
  if (!billingAnchor) throw notFoundError();
  if (!replay) {
    throw new WalletExceptionActionError(
      "wallet_exception_version_conflict",
      "The exception changed. Refresh before trying again.",
      409,
    );
  }
  if (
    replay.caseId !== input.caseId
    || replay.action !== input.action
    || replay.expectedVersion !== input.expectedVersion
    || replay.note !== input.note
  ) {
    throw new WalletExceptionActionError(
      "wallet_exception_idempotency_conflict",
      "This action key belongs to another request.",
      409,
    );
  }
  const exceptionCase = await client.walletExceptionCase.findFirst({
    where: {
      id: input.caseId,
      ownerId: input.ownerId,
    },
    include: walletExceptionViewInclude,
  });
  if (!exceptionCase) throw notFoundError();
  return serializeWalletExceptionCase(
    exceptionCase,
    input.ownerId,
  );
}

function isConcurrentActionConflict(error: unknown): boolean {
  const code = prismaErrorCode(error);
  return code === "P2002" || code === "P2034";
}

function prismaErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

const walletExceptionViewInclude = {
  representative: {
    select: {
      slug: true,
      displayName: true,
    },
  },
  outboxEvent: {
    select: {
      status: true,
      eventType: true,
      aggregateType: true,
      aggregateId: true,
    },
  },
  rechargeRefund: {
    select: {
      id: true,
      rechargeOrder: {
        select: {
          representative: {
            select: { ownerId: true },
          },
        },
      },
    },
  },
} satisfies Prisma.WalletExceptionCaseInclude;

type WalletExceptionWithView =
  Prisma.WalletExceptionCaseGetPayload<{
    include: typeof walletExceptionViewInclude;
  }>;

async function findOwnedCase(
  tx: Prisma.TransactionClient,
  caseId: string,
  ownerId: string,
): Promise<WalletExceptionWithView | null> {
  return tx.walletExceptionCase.findFirst({
    where: {
      id: caseId,
      ownerId,
    },
    include: walletExceptionViewInclude,
  });
}

async function assertCurrentOwnerScope(
  tx: Prisma.TransactionClient,
  exceptionCase: WalletExceptionWithView,
  ownerId: string,
): Promise<void> {
  if (
    exceptionCase.sourceType
    === WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX
  ) {
    const orderId = exceptionCase.outboxEvent?.aggregateId;
    if (!orderId) throw notFoundError();
    const order = await tx.rechargeOrder.findFirst({
      where: {
        id: orderId,
        provider: PaymentProvider.WECHAT_PAY,
        representative: { ownerId },
      },
      select: { id: true },
    });
    if (!order) throw notFoundError();
    return;
  }
  if (
    exceptionCase.rechargeRefund?.rechargeOrder
      .representative?.ownerId !== ownerId
  ) {
    throw notFoundError();
  }
  if (
    (
      exceptionCase.sourceType
        === WalletExceptionSourceType.REFUND_LIFECYCLE_OUTBOX
      || exceptionCase.sourceType
        === WalletExceptionSourceType.REFUND_REVERSAL_OUTBOX
    )
    && exceptionCase.outboxEvent?.aggregateId
      !== exceptionCase.rechargeRefund.id
  ) {
    throw notFoundError();
  }
}

function assertActionTransition(
  exceptionCase: WalletExceptionWithView,
  action: WalletExceptionActionType,
  ownerId: string,
): void {
  if (
    action === WalletExceptionActionType.CLAIM
    && exceptionCase.status === WalletExceptionCaseStatus.OPEN
  ) {
    return;
  }
  if (
    (
      action === WalletExceptionActionType.RETRY
      || action === WalletExceptionActionType.ACKNOWLEDGE
    )
    && exceptionCase.status
      === WalletExceptionCaseStatus.CLAIMED
    && exceptionCase.claimedByOwnerId === ownerId
  ) {
    return;
  }
  throw new WalletExceptionActionError(
    "wallet_exception_state_conflict",
    "This action is not allowed in the current exception state.",
    409,
  );
}

function serializeWalletExceptionCase(
  exceptionCase: WalletExceptionWithView,
  ownerId: string,
): WalletExceptionCaseView {
  return {
    id: exceptionCase.id,
    kind: exceptionCase.kind,
    reasonCode: exceptionCase.reasonCode,
    severity: exceptionCase.severity.toLowerCase() as
      WalletExceptionCaseView["severity"],
    status: exceptionCase.status.toLowerCase() as
      WalletExceptionCaseView["status"],
    version: exceptionCase.version,
    representativeSlug: exceptionCase.representative.slug,
    representativeName:
      exceptionCase.representative.displayName,
    currency: exceptionCase.currency,
    createdAt: exceptionCase.createdAt.toISOString(),
    updatedAt: exceptionCase.updatedAt.toISOString(),
    retryable:
      isOutboxSourceType(exceptionCase.sourceType)
      && exceptionCase.outboxEvent !== null
      && (
        exceptionCase.outboxEvent.status
          === ReliableEventStatus.FAILED
        || exceptionCase.outboxEvent.status
          === ReliableEventStatus.DEAD_LETTER
      ),
    claimedByCurrentOwner:
      exceptionCase.claimedByOwnerId === ownerId,
  };
}

function assertRetryableOutbox(
  exceptionCase: WalletExceptionWithView,
): void {
  const expectedEventType = expectedEventTypeForSource(
    exceptionCase.sourceType,
  );
  if (
    !expectedEventType
    || !exceptionCase.outboxEventId
    || exceptionCase.sourceId !== exceptionCase.outboxEventId
    || exceptionCase.outboxEvent?.eventType !== expectedEventType
    || exceptionCase.outboxEvent.aggregateType
      !== expectedAggregateTypeForSource(
        exceptionCase.sourceType,
      )
    || (
      exceptionCase.outboxEvent.status
        !== ReliableEventStatus.FAILED
      && exceptionCase.outboxEvent.status
        !== ReliableEventStatus.DEAD_LETTER
    )
  ) {
    throw new WalletExceptionActionError(
      "wallet_exception_not_retryable",
      "This exception is not bound to a retryable operation.",
      409,
    );
  }
}

function expectedAggregateTypeForSource(
  sourceType: WalletExceptionSourceType,
): "recharge_order" | "recharge_refund" | null {
  switch (sourceType) {
    case WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX:
      return "recharge_order";
    case WalletExceptionSourceType.REFUND_LIFECYCLE_OUTBOX:
    case WalletExceptionSourceType.REFUND_REVERSAL_OUTBOX:
      return "recharge_refund";
    case WalletExceptionSourceType.REFUND_RECONCILIATION:
    case WalletExceptionSourceType.REFUND_ABNORMAL:
      return null;
  }
}

function expectedEventTypeForSource(
  sourceType: WalletExceptionSourceType,
): string | null {
  switch (sourceType) {
    case WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX:
      return WECHAT_ORDER_RECONCILIATION_EVENT_TYPE;
    case WalletExceptionSourceType.REFUND_LIFECYCLE_OUTBOX:
      return WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE;
    case WalletExceptionSourceType.REFUND_REVERSAL_OUTBOX:
      return WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE;
    case WalletExceptionSourceType.REFUND_RECONCILIATION:
    case WalletExceptionSourceType.REFUND_ABNORMAL:
      return null;
  }
}

function actionCaseUpdate(
  action: WalletExceptionActionType,
  ownerId: string,
  note: string | null,
  now: Date,
): Prisma.WalletExceptionCaseUncheckedUpdateManyInput {
  switch (action) {
    case WalletExceptionActionType.CLAIM:
      return {
        status: WalletExceptionCaseStatus.CLAIMED,
        claimedByOwnerId: ownerId,
        claimedAt: now,
      };
    case WalletExceptionActionType.RETRY:
      return {};
    case WalletExceptionActionType.ACKNOWLEDGE:
      return {
        status: WalletExceptionCaseStatus.ACKNOWLEDGED,
        acknowledgedByOwnerId: ownerId,
        acknowledgedAt: now,
        note,
      };
  }
}

function actionEnum(
  action: WalletExceptionActionName,
): WalletExceptionActionType {
  switch (action) {
    case "claim":
      return WalletExceptionActionType.CLAIM;
    case "retry":
      return WalletExceptionActionType.RETRY;
    case "acknowledge":
      return WalletExceptionActionType.ACKNOWLEDGE;
    default:
      throw new WalletExceptionActionError(
        "wallet_exception_action_invalid",
        "Unsupported wallet exception action.",
        400,
      );
  }
}

function isOutboxSourceType(
  sourceType: WalletExceptionSourceType,
): boolean {
  return (OUTBOX_SOURCE_TYPES as readonly WalletExceptionSourceType[])
    .includes(sourceType);
}

function sourceIsRecovered(exceptionCase: {
  sourceType: WalletExceptionSourceType;
  outboxEvent: { status: ReliableEventStatus } | null;
  rechargeRefund: {
    reversalStatus: RechargeRefundReversalStatus;
    providerStatus: RechargeRefundProviderStatus | null;
  } | null;
}): boolean {
  switch (exceptionCase.sourceType) {
    case WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX:
    case WalletExceptionSourceType.REFUND_LIFECYCLE_OUTBOX:
    case WalletExceptionSourceType.REFUND_REVERSAL_OUTBOX:
      return (
        exceptionCase.outboxEvent?.status
        === ReliableEventStatus.PROCESSED
      );
    case WalletExceptionSourceType.REFUND_RECONCILIATION:
      return (
        exceptionCase.rechargeRefund?.reversalStatus
          === RechargeRefundReversalStatus.APPLIED
        || exceptionCase.rechargeRefund?.reversalStatus
          === RechargeRefundReversalStatus.NOT_REQUIRED
      );
    case WalletExceptionSourceType.REFUND_ABNORMAL:
      return (
        exceptionCase.rechargeRefund?.providerStatus
          === RechargeRefundProviderStatus.SUCCEEDED
        || exceptionCase.rechargeRefund?.providerStatus
          === RechargeRefundProviderStatus.CLOSED
      );
  }
}

async function upsertDetectedCase(
  client: typeof prisma,
  input: {
    ownerId: string;
    representativeId: string;
    currency: string;
    kind: string;
    reasonCode: string;
    severity: WalletExceptionSeverity;
    sourceType: WalletExceptionSourceType;
    sourceId: string;
    outboxEventId: string | null;
    rechargeRefundId: string | null;
    now: Date;
  },
): Promise<void> {
  await client.walletExceptionCase.upsert({
    where: {
      sourceType_sourceId: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      },
    },
    create: {
      ownerId: input.ownerId,
      representativeId: input.representativeId,
      currency: input.currency,
      kind: input.kind,
      reasonCode: input.reasonCode,
      severity: input.severity,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      outboxEventId: input.outboxEventId,
      rechargeRefundId: input.rechargeRefundId,
      firstDetectedAt: input.now,
      lastDetectedAt: input.now,
    },
    update: {
      kind: input.kind,
      reasonCode: input.reasonCode,
      severity: input.severity,
      lastDetectedAt: input.now,
    },
  });
  await client.walletExceptionCase.updateMany({
    where: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: WalletExceptionCaseStatus.RESOLVED,
    },
    data: {
      status: WalletExceptionCaseStatus.OPEN,
      claimedByOwnerId: null,
      claimedAt: null,
      acknowledgedByOwnerId: null,
      acknowledgedAt: null,
      note: null,
      resolvedAt: null,
      version: { increment: 1 },
    },
  });
}

function ownerScopeFromOrder(
  order:
    | {
        representativeId: string | null;
        currency: string;
        representative: { ownerId: string } | null;
      }
    | undefined,
): {
  ownerId: string;
  representativeId: string;
  currency: string;
} | null {
  if (!order?.representativeId || !order.representative) {
    return null;
  }
  return {
    ownerId: order.representative.ownerId,
    representativeId: order.representativeId,
    currency: order.currency,
  };
}

function ownerScopeFromRefund(
  refund:
    | {
        currency: string;
        rechargeOrder: {
          representativeId: string | null;
          representative: { ownerId: string } | null;
        };
      }
    | undefined,
): {
  ownerId: string;
  representativeId: string;
  currency: string;
} | null {
  if (
    !refund?.rechargeOrder.representativeId
    || !refund.rechargeOrder.representative
  ) {
    return null;
  }
  return {
    ownerId: refund.rechargeOrder.representative.ownerId,
    representativeId: refund.rechargeOrder.representativeId,
    currency: refund.currency,
  };
}

function sourceKey(
  sourceType: WalletExceptionSourceType,
  sourceId: string,
): string {
  return `${sourceType}:${sourceId}`;
}

function requiredText(
  value: string,
  name: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximumLength
  ) {
    throw new WalletExceptionActionError(
      "wallet_exception_action_invalid",
      `${name} is invalid.`,
      400,
    );
  }
  return normalized;
}

function normalizedNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const note = value.trim();
  if (note.length > 1_000) {
    throw new WalletExceptionActionError(
      "wallet_exception_action_invalid",
      "The note is too long.",
      400,
    );
  }
  return note || null;
}

function notFoundError(): WalletExceptionActionError {
  return new WalletExceptionActionError(
    "wallet_exception_not_found",
    "Wallet exception was not found.",
    404,
  );
}
