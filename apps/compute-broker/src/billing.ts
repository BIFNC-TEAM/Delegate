import type { CapabilityKind } from "@delegate/compute-protocol";

import { prisma } from "./prisma";

type BudgetContext = {
  conversationId?: string | null;
  representative: {
    owner: {
      id: string;
      wallet: {
        balanceCredits: number;
        sponsorPoolCredit: number;
      } | null;
    };
  };
  conversation?: {
    computeBudgetRemainingCredits: number | null;
  } | null;
};

export type ExecutionBillingSummary = {
  estimatedCredits?: number;
  actualCredits?: number;
  computeCostCents?: number;
  browserCostCents?: number;
  providerCostCents?: number;
  mcpCostCents?: number;
  storageCostCents?: number;
  conversationBudgetRemainingCredits?: number | null;
  ownerBalanceCredits?: number | null;
  sponsorPoolCredit?: number | null;
};

export function estimateCreditUsage(params: {
  capability: CapabilityKind;
  estimatedCostCents?: number;
  artifactBytes?: number;
}): number {
  const base =
    params.capability === "browser"
      ? 8
      : params.capability === "mcp"
        ? 6
      : params.capability === "write"
        ? 4
        : params.capability === "process"
          ? 3
          : params.capability === "read"
            ? 2
            : 2;
  const costComponent =
    typeof params.estimatedCostCents === "number"
      ? Math.max(base, Math.ceil(params.estimatedCostCents / 2))
      : base;
  const artifactComponent =
    typeof params.artifactBytes === "number" && params.artifactBytes > 0
      ? Math.ceil(params.artifactBytes / 65536)
      : 0;

  return Math.max(base, costComponent + artifactComponent);
}

export function summarizeBudgetAvailability(context: BudgetContext) {
  const conversationCredits = context.conversation?.computeBudgetRemainingCredits ?? null;
  const ownerBalanceCredits = context.representative.owner.wallet?.balanceCredits ?? null;
  const sponsorPoolCredit = context.representative.owner.wallet?.sponsorPoolCredit ?? null;
  const totalAvailableCredits =
    Math.max(0, conversationCredits ?? 0) +
    Math.max(0, ownerBalanceCredits ?? 0) +
    Math.max(0, sponsorPoolCredit ?? 0);

  return {
    conversationCredits,
    ownerBalanceCredits,
    sponsorPoolCredit,
    totalAvailableCredits,
  };
}

export async function applyExecutionBilling(params: {
  representativeId: string;
  contactId?: string | null;
  conversationId?: string | null;
  sessionId: string;
  toolExecutionId: string;
  delegationTaskId?: string | null;
  ownerId: string;
  computeCredits: number;
  storageCredits: number;
  computeCostCents: number;
  browserCostCents: number;
  providerCostCents: number;
  mcpCostCents: number;
  storageCostCents: number;
  capability: CapabilityKind;
  wallMs: number;
  artifactBytes: number;
  finishedAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const conversation =
      params.conversationId
        ? await tx.conversation.findUnique({
            where: { id: params.conversationId },
            select: {
              id: true,
              computeBudgetRemainingCredits: true,
            },
          })
        : null;
    const wallet = await tx.wallet.findUnique({
      where: { ownerId: params.ownerId },
      select: {
        ownerId: true,
        balanceCredits: true,
        sponsorPoolCredit: true,
      },
    });

    let remainingConversationCredits = conversation?.computeBudgetRemainingCredits ?? null;
    let remainingOwnerBalanceCredits = wallet?.balanceCredits ?? null;
    let remainingSponsorPoolCredits = wallet?.sponsorPoolCredit ?? null;
    const totalCreditsToCharge = params.computeCredits + params.storageCredits;
    let creditsLeftToCharge = totalCreditsToCharge;
    let debitedFromConversation = 0;
    let debitedFromOwner = 0;
    let debitedFromSponsor = 0;

    if (
      typeof remainingConversationCredits === "number" &&
      remainingConversationCredits > 0 &&
      creditsLeftToCharge > 0
    ) {
      const debit = Math.min(remainingConversationCredits, creditsLeftToCharge);
      remainingConversationCredits -= debit;
      creditsLeftToCharge -= debit;
      debitedFromConversation += debit;
    }

    if (
      typeof remainingOwnerBalanceCredits === "number" &&
      remainingOwnerBalanceCredits > 0 &&
      creditsLeftToCharge > 0
    ) {
      const debit = Math.min(remainingOwnerBalanceCredits, creditsLeftToCharge);
      remainingOwnerBalanceCredits -= debit;
      creditsLeftToCharge -= debit;
      debitedFromOwner += debit;
    }

    if (
      typeof remainingSponsorPoolCredits === "number" &&
      remainingSponsorPoolCredits > 0 &&
      creditsLeftToCharge > 0
    ) {
      const debit = Math.min(remainingSponsorPoolCredits, creditsLeftToCharge);
      remainingSponsorPoolCredits -= debit;
      creditsLeftToCharge -= debit;
      debitedFromSponsor += debit;
    }

    if (conversation?.id) {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          computeBudgetRemainingCredits:
            typeof remainingConversationCredits === "number"
              ? remainingConversationCredits
              : conversation.computeBudgetRemainingCredits,
          lastComputeAt: params.finishedAt,
        },
      });
    }

    if (wallet) {
      await tx.wallet.update({
        where: { ownerId: params.ownerId },
        data: {
          balanceCredits:
            typeof remainingOwnerBalanceCredits === "number"
              ? remainingOwnerBalanceCredits
              : wallet.balanceCredits,
          sponsorPoolCredit:
            typeof remainingSponsorPoolCredits === "number"
              ? remainingSponsorPoolCredits
              : wallet.sponsorPoolCredit,
        },
      });
    }

    await tx.ledgerEntry.create({
      data: {
        representativeId: params.representativeId,
        contactId: params.contactId ?? null,
        conversationId: params.conversationId ?? null,
        sessionId: params.sessionId,
        toolExecutionId: params.toolExecutionId,
        delegationTaskId: params.delegationTaskId ?? null,
        kind: "COMPUTE_MINUTES",
        quantity: Math.max(params.wallMs / 60000, params.wallMs > 0 ? 1 / 60 : 0),
        unit: "minute",
        costCents: params.computeCostCents,
        creditDelta: 0,
        notes: "compute_usage",
      },
    });

    await tx.ledgerEntry.create({
      data: {
        representativeId: params.representativeId,
        contactId: params.contactId ?? null,
        conversationId: params.conversationId ?? null,
        sessionId: params.sessionId,
        toolExecutionId: params.toolExecutionId,
        delegationTaskId: params.delegationTaskId ?? null,
        kind: "STORAGE_BYTES",
        quantity: params.artifactBytes,
        unit: "byte",
        costCents: params.storageCostCents,
        creditDelta: 0,
        notes: "artifact_storage_charge",
      },
    });

    if (params.capability === "browser") {
      await tx.ledgerEntry.create({
        data: {
          representativeId: params.representativeId,
          contactId: params.contactId ?? null,
          conversationId: params.conversationId ?? null,
          sessionId: params.sessionId,
          toolExecutionId: params.toolExecutionId,
          delegationTaskId: params.delegationTaskId ?? null,
          kind: "BROWSER_MINUTES",
          quantity: Math.max(params.wallMs / 60000, params.wallMs > 0 ? 1 / 60 : 0),
          unit: "minute",
          costCents: params.browserCostCents,
          creditDelta: 0,
          notes: "browser_usage",
        },
      });
    }

    if (params.providerCostCents > 0) {
      await tx.ledgerEntry.create({
        data: {
          representativeId: params.representativeId,
          contactId: params.contactId ?? null,
          conversationId: params.conversationId ?? null,
          sessionId: params.sessionId,
          toolExecutionId: params.toolExecutionId,
          delegationTaskId: params.delegationTaskId ?? null,
          kind: "MODEL_USAGE",
          quantity: 1,
          unit: "request",
          costCents: params.providerCostCents,
          creditDelta: 0,
          notes: "native_provider_usage",
        },
      });
    }

    if (params.mcpCostCents > 0) {
      await tx.ledgerEntry.create({
        data: {
          representativeId: params.representativeId,
          contactId: params.contactId ?? null,
          conversationId: params.conversationId ?? null,
          sessionId: params.sessionId,
          toolExecutionId: params.toolExecutionId,
          delegationTaskId: params.delegationTaskId ?? null,
          kind: "MCP_CALLS",
          quantity: 1,
          unit: "call",
          costCents: params.mcpCostCents,
          creditDelta: 0,
          notes: "mcp_remote_usage",
        },
      });
    }

    const debitEntries = [
      {
        source: "conversation_budget",
        amount: debitedFromConversation,
      },
      {
        source: "owner_wallet",
        amount: debitedFromOwner,
      },
      {
        source: "sponsor_pool",
        amount: debitedFromSponsor,
      },
    ].filter((entry) => entry.amount > 0);

    if (!debitEntries.length && totalCreditsToCharge > 0) {
      debitEntries.push({
        source: "unsettled",
        amount: totalCreditsToCharge,
      });
    }

    await Promise.all(
      debitEntries.map((entry) =>
        tx.ledgerEntry.create({
          data: {
            representativeId: params.representativeId,
            contactId: params.contactId ?? null,
            conversationId: params.conversationId ?? null,
            sessionId: params.sessionId,
            toolExecutionId: params.toolExecutionId,
            delegationTaskId: params.delegationTaskId ?? null,
            kind: "PLAN_DEBIT",
            quantity: entry.amount,
            unit: "credit",
            costCents: 0,
            creditDelta: -entry.amount,
            notes: `${entry.source}_debit`,
          },
        }),
      ),
    );

    return {
      actualCredits: totalCreditsToCharge,
      computeCostCents: params.computeCostCents,
      browserCostCents: params.browserCostCents,
      providerCostCents: params.providerCostCents,
      mcpCostCents: params.mcpCostCents,
      storageCostCents: params.storageCostCents,
      conversationBudgetRemainingCredits: remainingConversationCredits,
      ownerBalanceCredits: remainingOwnerBalanceCredits,
      sponsorPoolCredit: remainingSponsorPoolCredits,
    } satisfies ExecutionBillingSummary;
  });
}
