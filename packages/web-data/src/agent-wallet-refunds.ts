import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import { prisma } from "./prisma";

type UserWalletRecord = {
  id: string;
  externalUserId: string;
  currency: string;
  cashBalanceCents: number;
};

type AgentWalletRecord = {
  id: string;
  representativeId: string;
  currency: string;
  tokenBalance: number;
  totalPurchasedTokens: number;
  totalConsumedTokens: number;
};

type RechargeOrderRecord = {
  id: string;
  userWalletId: string;
  provider: PaymentProvider;
  providerOrderId: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  refundedAt: Date | null;
  userWallet?: UserWalletRecord;
};

type PaymentProviderEventRecord = {
  id: string;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
};

type AgentTokenPurchaseRecord = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  representativeId: string;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  creatorPendingCents: number;
  status: AgentTokenPurchaseStatus;
  idempotencyKey: string;
  refundedAt: Date | null;
  userWallet?: UserWalletRecord;
  agentWallet?: AgentWalletRecord;
  creatorEarnings?: CreatorEarningRecord[];
};

type CreatorEarningRecord = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  tokenPurchaseId: string | null;
  status: CreatorEarningStatus;
  pendingCents: number;
  withdrawableCents: number;
  currency: string;
};

type RechargeRefundClient = Omit<WalletLedgerClient, "$transaction"> & {
  userWallet: {
    update(args: unknown): Promise<UserWalletRecord>;
  };
  rechargeOrder: {
    findUnique(args: unknown): Promise<RechargeOrderRecord | null>;
    update(args: unknown): Promise<RechargeOrderRecord>;
  };
  paymentProviderEvent: {
    upsert(args: unknown): Promise<PaymentProviderEventRecord>;
  };
  $transaction?<T>(fn: (tx: RechargeRefundClient) => Promise<T>): Promise<T>;
};

type PurchaseReversalClient = Omit<WalletLedgerClient, "$transaction"> & {
  userWallet: {
    update(args: unknown): Promise<UserWalletRecord>;
  };
  agentWallet: {
    update(args: unknown): Promise<AgentWalletRecord>;
  };
  agentTokenPurchase: {
    findUnique(args: unknown): Promise<AgentTokenPurchaseRecord | null>;
    update(args: unknown): Promise<AgentTokenPurchaseRecord>;
  };
  creatorEarning: {
    findFirst(args: unknown): Promise<CreatorEarningRecord | null>;
    update(args: unknown): Promise<CreatorEarningRecord>;
  };
  $transaction?<T>(fn: (tx: PurchaseReversalClient) => Promise<T>): Promise<T>;
};

export type RefundRechargeOrderInput = {
  providerEventId?: string;
  reason?: string;
};

export type RechargeRefundSnapshot = {
  rechargeOrderId: string;
  status: "created" | "requires_payment" | "paid" | "failed" | "canceled" | "refunded";
  amountCents: number;
  currency: string;
  cashBalanceCents: number;
  paymentProviderEventId: string | null;
  refundedAt: string | null;
};

export type ReverseAgentTokenPurchaseInput = {
  reason?: string;
};

export type AgentTokenPurchaseReversalSnapshot = {
  purchaseId: string;
  status: "pending" | "completed" | "failed" | "refunded" | "reversed";
  amountCents: number;
  currency: string;
  tokenAmount: number;
  cashBalanceCents: number;
  agentTokenBalance: number;
  creatorReversedCents: number;
  refundedAt: string | null;
};

export async function refundRechargeOrder(
  rechargeOrderId: string,
  input: RefundRechargeOrderInput = {},
  client: RechargeRefundClient = prisma,
): Promise<RechargeRefundSnapshot> {
  if (!rechargeOrderId.trim()) {
    throw new Error("Recharge order id is required.");
  }

  const run = async (tx: RechargeRefundClient) => {
    const order = await tx.rechargeOrder.findUnique({
      where: { id: rechargeOrderId },
      include: { userWallet: true },
    });
    if (!order?.userWallet) {
      throw new Error("Recharge order not found.");
    }
    if (order.status === RechargeOrderStatus.REFUNDED) {
      return serializeRechargeRefund(order, null);
    }
    if (order.status !== RechargeOrderStatus.PAID) {
      throw new Error(`Recharge order cannot be refunded from status ${order.status}.`);
    }
    if (order.userWallet.cashBalanceCents < order.amountCents) {
      throw new Error("Recharge refund requires unspent user wallet cash.");
    }

    const refundedAt = new Date();
    const providerEventId =
      input.providerEventId ?? `refund_${order.provider.toLowerCase()}_${order.id}`;
    const providerEvent = await tx.paymentProviderEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: order.provider,
          providerEventId,
        },
      },
      create: {
        provider: order.provider,
        providerEventId,
        eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
        rechargeOrderId: order.id,
        rawPayload: {
          provider: order.provider,
          providerEventId,
          rechargeOrderId: order.id,
          reason: input.reason ?? null,
        },
        normalizedPayload: {
          type: "RechargeRefunded",
          rechargeOrderId: order.id,
          amountCents: order.amountCents,
          currency: order.currency,
        },
        processedAt: refundedAt,
        idempotencyKey: `refund:${order.provider}:${providerEventId}`,
      },
      update: {
        processedAt: refundedAt,
      },
    });

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `recharge_refund:${order.id}`,
        idempotencyKey: `recharge_refund:${order.id}:completed`,
        currency: order.currency,
        initialBalances: {
          [`${AmnWalletAccountType.USER_CASH}:${order.userWallet.id}`]: {
            amountCents: order.userWallet.cashBalanceCents,
          },
        },
        movements: [
          {
            entryKey: "user_cash_refund_debit",
            accountType: AmnWalletAccountType.USER_CASH,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            userWalletId: order.userWallet.id,
            rechargeOrderId: order.id,
            paymentProviderEventId: providerEvent.id,
            amountCents: -order.amountCents,
            notes: input.reason ?? "recharge_refund",
          },
        ],
      },
      tx,
    );

    const [updatedWallet, updatedOrder] = await Promise.all([
      tx.userWallet.update({
        where: { id: order.userWallet.id },
        data: {
          cashBalanceCents: {
            decrement: order.amountCents,
          },
        },
      }),
      tx.rechargeOrder.update({
        where: { id: order.id },
        data: {
          status: RechargeOrderStatus.REFUNDED,
          refundedAt,
        },
      }),
    ]);

    return serializeRechargeRefund(
      { ...updatedOrder, userWallet: updatedWallet },
      providerEvent,
    );
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

export async function reverseAgentTokenPurchase(
  purchaseId: string,
  input: ReverseAgentTokenPurchaseInput = {},
  client: PurchaseReversalClient = prisma,
): Promise<AgentTokenPurchaseReversalSnapshot> {
  if (!purchaseId.trim()) {
    throw new Error("Agent token purchase id is required.");
  }

  const run = async (tx: PurchaseReversalClient) => {
    const purchase = await tx.agentTokenPurchase.findUnique({
      where: { id: purchaseId },
      include: {
        userWallet: true,
        agentWallet: true,
        creatorEarnings: true,
      },
    });
    if (!purchase?.userWallet || !purchase.agentWallet) {
      throw new Error("Agent token purchase not found.");
    }
    if (
      purchase.status === AgentTokenPurchaseStatus.REVERSED ||
      purchase.status === AgentTokenPurchaseStatus.REFUNDED
    ) {
      return serializePurchaseReversal(purchase, 0);
    }
    if (purchase.status !== AgentTokenPurchaseStatus.COMPLETED) {
      throw new Error(`Agent token purchase cannot be reversed from status ${purchase.status}.`);
    }
    if (purchase.agentWallet.tokenBalance < purchase.tokenAmount) {
      throw new Error("Cannot reverse purchase after tokens are consumed.");
    }

    const pendingEarning = await tx.creatorEarning.findFirst({
      where: {
        tokenPurchaseId: purchase.id,
        status: CreatorEarningStatus.PENDING,
        pendingCents: { gt: 0 },
      },
      orderBy: { createdAt: "asc" },
    });
    const creatorReversedCents = pendingEarning?.pendingCents ?? 0;
    const platformReversedCents = purchase.amountCents - creatorReversedCents;
    const refundedAt = new Date();

    const updatedPendingEarning =
      pendingEarning && creatorReversedCents > 0
        ? await tx.creatorEarning.update({
            where: { id: pendingEarning.id },
            data: {
              pendingCents: 0,
              status: CreatorEarningStatus.REVERSED,
            },
          })
        : null;

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `token_purchase_reversal:${purchase.id}`,
        idempotencyKey: `token_purchase_reversal:${purchase.id}:completed`,
        currency: purchase.currency,
        requireBalancedAmount: true,
        initialBalances: {
          [`${AmnWalletAccountType.USER_CASH}:${purchase.userWallet.id}`]: {
            amountCents: purchase.userWallet.cashBalanceCents,
          },
          [`${AmnWalletAccountType.AGENT_TOKEN}:${purchase.agentWallet.id}`]: {
            tokenAmount: purchase.agentWallet.tokenBalance,
          },
          ...(pendingEarning
            ? {
                [`${AmnWalletAccountType.CREATOR_PENDING}:${pendingEarning.ownerId}:${pendingEarning.representativeId}`]:
                  {
                    amountCents: pendingEarning.pendingCents,
                  },
              }
            : {}),
        },
        movements: [
          {
            entryKey: "user_cash_refund_credit",
            accountType: AmnWalletAccountType.USER_CASH,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            userWalletId: purchase.userWallet.id,
            tokenPurchaseId: purchase.id,
            amountCents: purchase.amountCents,
            notes: input.reason ?? "agent_token_purchase_reversal",
          },
          {
            entryKey: "agent_token_reversal_debit",
            accountType: AmnWalletAccountType.AGENT_TOKEN,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            agentWalletId: purchase.agentWallet.id,
            representativeId: purchase.representativeId,
            tokenPurchaseId: purchase.id,
            tokenAmount: -purchase.tokenAmount,
            notes: input.reason ?? "agent_token_purchase_reversal",
          },
          ...(updatedPendingEarning
            ? [
                {
                  entryKey: "creator_pending_reversal_debit",
                  accountType: AmnWalletAccountType.CREATOR_PENDING,
                  entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
                  ownerId: updatedPendingEarning.ownerId,
                  representativeId: updatedPendingEarning.representativeId,
                  agentWalletId: updatedPendingEarning.agentWalletId,
                  creatorEarningId: updatedPendingEarning.id,
                  tokenPurchaseId: purchase.id,
                  amountCents: -creatorReversedCents,
                  notes: input.reason ?? "agent_token_purchase_reversal",
                },
              ]
            : []),
          {
            entryKey: "platform_revenue_reversal_debit",
            accountType: AmnWalletAccountType.PLATFORM_REVENUE,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            representativeId: purchase.representativeId,
            tokenPurchaseId: purchase.id,
            amountCents: -platformReversedCents,
            notes: input.reason ?? "agent_token_purchase_reversal",
          },
        ],
      },
      tx,
    );

    const [updatedUserWallet, updatedAgentWallet, updatedPurchase] = await Promise.all([
      tx.userWallet.update({
        where: { id: purchase.userWallet.id },
        data: {
          cashBalanceCents: {
            increment: purchase.amountCents,
          },
        },
      }),
      tx.agentWallet.update({
        where: { id: purchase.agentWallet.id },
        data: {
          tokenBalance: {
            decrement: purchase.tokenAmount,
          },
          totalPurchasedTokens: {
            decrement: purchase.tokenAmount,
          },
        },
      }),
      tx.agentTokenPurchase.update({
        where: { id: purchase.id },
        data: {
          status: AgentTokenPurchaseStatus.REVERSED,
          refundedAt,
        },
      }),
    ]);

    return serializePurchaseReversal(
      {
        ...updatedPurchase,
        userWallet: updatedUserWallet,
        agentWallet: updatedAgentWallet,
        creatorEarnings: updatedPendingEarning ? [updatedPendingEarning] : [],
      },
      creatorReversedCents,
    );
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

function serializeRechargeRefund(
  order: RechargeOrderRecord,
  providerEvent: PaymentProviderEventRecord | null,
): RechargeRefundSnapshot {
  if (!order.userWallet) {
    throw new Error("Recharge refund is missing user wallet.");
  }
  return {
    rechargeOrderId: order.id,
    status: order.status.toLowerCase() as RechargeRefundSnapshot["status"],
    amountCents: order.amountCents,
    currency: order.currency,
    cashBalanceCents: order.userWallet.cashBalanceCents,
    paymentProviderEventId: providerEvent?.id ?? null,
    refundedAt: order.refundedAt ? order.refundedAt.toISOString() : null,
  };
}

function serializePurchaseReversal(
  purchase: AgentTokenPurchaseRecord,
  creatorReversedCents: number,
): AgentTokenPurchaseReversalSnapshot {
  if (!purchase.userWallet) {
    throw new Error("Purchase reversal is missing user wallet.");
  }
  if (!purchase.agentWallet) {
    throw new Error("Purchase reversal is missing agent wallet.");
  }
  return {
    purchaseId: purchase.id,
    status: purchase.status.toLowerCase() as AgentTokenPurchaseReversalSnapshot["status"],
    amountCents: purchase.amountCents,
    currency: purchase.currency,
    tokenAmount: purchase.tokenAmount,
    cashBalanceCents: purchase.userWallet.cashBalanceCents,
    agentTokenBalance: purchase.agentWallet.tokenBalance,
    creatorReversedCents,
    refundedAt: purchase.refundedAt ? purchase.refundedAt.toISOString() : null,
  };
}
