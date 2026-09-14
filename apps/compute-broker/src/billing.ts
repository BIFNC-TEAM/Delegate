import type { CapabilityKind } from "@delegate/compute-protocol";
import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import { SessionError } from "./session-error";

export type ExecutionCostSummary = {
  computeCostCents: number;
  browserCostCents: number;
  providerCostCents: number;
  mcpCostCents: number;
  storageCostCents: number;
};

export async function recordExecutionCosts(params: {
  representativeId: string;
  contactId?: string | null;
  conversationId?: string | null;
  sessionId: string;
  toolExecutionId: string;
  computeCostCents: number;
  browserCostCents: number;
  providerCostCents: number;
  mcpCostCents: number;
  storageCostCents: number;
  capability: CapabilityKind;
  wallMs: number;
  artifactBytes: number;
  finishedAt: Date;
  expectedExecutionLeaseToken: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT "id"
      FROM "ToolExecution"
      WHERE "id" = ${params.toolExecutionId}
      FOR UPDATE
    `;
    const execution = await tx.toolExecution.findUnique({
      where: { id: params.toolExecutionId },
      select: {
        billingSnapshot: true,
        executionLeaseToken: true,
        status: true,
      },
    });
    if (!execution) throw new Error("tool_execution_not_found_for_cost_recording");
    if (
      execution.status !== "RUNNING"
      || execution.executionLeaseToken !== params.expectedExecutionLeaseToken
    ) {
      throw new SessionError(409, "compute_execution_claim_lost");
    }
    const existing = readExecutionCostSummary(execution.billingSnapshot);
    if (existing) {
      return existing;
    }

    if (params.conversationId) {
      await tx.conversation.update({
        where: { id: params.conversationId },
        data: { lastComputeAt: params.finishedAt },
      });
    }

    const common = {
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      conversationId: params.conversationId ?? null,
      sessionId: params.sessionId,
      toolExecutionId: params.toolExecutionId,
    };
    await tx.ledgerEntry.create({
        data: {
          ...common,
          kind: "COMPUTE_MINUTES",
          quantity: Math.max(params.wallMs / 60_000, params.wallMs > 0 ? 1 / 60 : 0),
          unit: "minute",
          costCents: params.computeCostCents,
          notes: "compute_usage",
        },
    });
    await tx.ledgerEntry.create({
        data: {
          ...common,
          kind: "STORAGE_BYTES",
          quantity: params.artifactBytes,
          unit: "byte",
          costCents: params.storageCostCents,
          notes: "artifact_storage_charge",
        },
    });
    if (params.capability === "browser") {
      await tx.ledgerEntry.create({
          data: {
            ...common,
            kind: "BROWSER_MINUTES",
            quantity: Math.max(params.wallMs / 60_000, params.wallMs > 0 ? 1 / 60 : 0),
            unit: "minute",
            costCents: params.browserCostCents,
            notes: "browser_usage",
          },
      });
    }
    if (params.providerCostCents > 0) {
      await tx.ledgerEntry.create({
          data: {
            ...common,
            kind: "MODEL_USAGE",
            quantity: 1,
            unit: "request",
            costCents: params.providerCostCents,
            notes: "native_provider_usage",
          },
      });
    }
    if (params.mcpCostCents > 0) {
      await tx.ledgerEntry.create({
          data: {
            ...common,
            kind: "MCP_CALLS",
            quantity: 1,
            unit: "call",
            costCents: params.mcpCostCents,
            notes: "mcp_remote_usage",
          },
      });
    }

    const summary = {
      computeCostCents: params.computeCostCents,
      browserCostCents: params.browserCostCents,
      providerCostCents: params.providerCostCents,
      mcpCostCents: params.mcpCostCents,
      storageCostCents: params.storageCostCents,
    } satisfies ExecutionCostSummary;
    const finalized = await tx.toolExecution.updateMany({
      where: {
        id: params.toolExecutionId,
        status: "RUNNING",
        executionLeaseToken: params.expectedExecutionLeaseToken,
        billingFinalizedAt: null,
      },
      data: {
        billingFinalizedAt: params.finishedAt,
        billingSnapshot: summary as Prisma.InputJsonValue,
      },
    });
    if (finalized.count !== 1) {
      throw new SessionError(409, "compute_execution_claim_lost");
    }
    return summary;
  });
}

function readExecutionCostSummary(value: unknown): ExecutionCostSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.computeCostCents !== "number"
    || typeof record.storageCostCents !== "number"
  ) return null;
  return value as ExecutionCostSummary;
}
