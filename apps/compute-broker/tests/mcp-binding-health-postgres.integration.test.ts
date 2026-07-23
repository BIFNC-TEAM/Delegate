import { describe, expect, it } from "vitest";

import { upsertRepresentativeMcpBinding } from "@delegate/web-data";

import {
  beginRepresentativeMcpBindingHealthObservation,
  recordRepresentativeMcpBindingFailure,
  recordRepresentativeMcpBindingSuccess,
} from "../src/mcp-bindings";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("MCP binding health PostgreSQL concurrency", () => {
  it("discards an old endpoint observation after a configuration edit", async () => {
    const binding = await createTemporaryBinding();

    try {
      const priorObservation = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T11:59:00.000Z",
      );
      await expect(recordRepresentativeMcpBindingFailure({
        observation: priorObservation,
        failureReason: "mcp_timeout",
        completedAt: new Date("2026-07-23T11:59:01.000Z"),
      })).resolves.toBe(true);
      const oldObservation = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:00.000Z",
      );
      await upsertRepresentativeMcpBinding({
        representativeSlug: binding.representative.slug,
        bindingId: binding.id,
        expectedUpdatedAt: binding.updatedAt.toISOString(),
        slug: binding.slug,
        displayName: binding.displayName,
        description: "edited endpoint",
        serverUrl: "https://mcp-new.example.com/mcp",
        transportKind: "streamable_http",
        allowedToolNames: ["lookup"],
        defaultToolName: "lookup",
        enabled: true,
        approvalRequired: true,
        estimatedCostCentsPerCall: 0,
        maxRetries: 0,
        retryBackoffMs: 100,
      });

      await expect(recordRepresentativeMcpBindingFailure({
        observation: oldObservation,
        failureReason: "mcp_timeout",
        completedAt: new Date("2026-07-23T12:00:30.000Z"),
      })).resolves.toBe(false);

      const current = await loadHealth(binding.id);
      expect(current).toMatchObject({
        configRevision: binding.configRevision + 1,
        healthRequestGeneration: 0n,
        lastHealthObservationGeneration: 0n,
        lastHealthObservationStartedAt: null,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureReason: null,
        lastSuccessAt: null,
      });
    } finally {
      await deleteTemporaryBinding(binding.id);
    }
  });

  it("keeps the latest-started request when an older request completes last", async () => {
    const binding = await createTemporaryBinding();

    try {
      const newer = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:01.000Z",
      );
      const older = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:00.000Z",
      );

      await expect(recordRepresentativeMcpBindingFailure({
        observation: newer,
        failureReason: "mcp_server_unavailable",
        completedAt: new Date("2026-07-23T12:00:02.000Z"),
      })).resolves.toBe(true);
      await expect(recordRepresentativeMcpBindingSuccess({
        observation: older,
        completedAt: new Date("2026-07-23T12:00:03.000Z"),
      })).resolves.toBe(false);

      const current = await loadHealth(binding.id);
      expect(current.consecutiveFailures).toBe(1);
      expect(current.lastFailureReason).toBe("mcp_server_unavailable");
      expect(current.lastHealthObservationStartedAt?.toISOString())
        .toBe("2026-07-23T12:00:01.000Z");
      expect(current.lastHealthObservationGeneration).toBe(newer.requestGeneration);
      expect(current.lastSuccessAt).toBeNull();
    } finally {
      await deleteTemporaryBinding(binding.id);
    }
  });

  it("converges on the latest-started request under concurrent result writes", async () => {
    const binding = await createTemporaryBinding();

    try {
      const older = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:00.000Z",
      );
      const newer = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:01.000Z",
      );

      const [, newerAccepted] = await Promise.all([
        recordRepresentativeMcpBindingSuccess({
          observation: older,
          completedAt: new Date("2026-07-23T12:00:03.000Z"),
        }),
        recordRepresentativeMcpBindingFailure({
          observation: newer,
          failureReason:
            "Bearer top-secret failed at https://user:password@example.com/mcp?token=top-secret",
          completedAt: new Date("2026-07-23T12:00:02.000Z"),
        }),
      ]);

      expect(newerAccepted).toBe(true);
      const current = await loadHealth(binding.id);
      expect(current.consecutiveFailures).toBe(1);
      expect(current.lastFailureReason).toBe("mcp_execution_failed");
      expect(current.lastFailureReason).not.toMatch(/https|secret|token=|bearer/u);
      expect(current.lastHealthObservationStartedAt?.toISOString())
        .toBe("2026-07-23T12:00:01.000Z");
    } finally {
      await deleteTemporaryBinding(binding.id);
    }
  });

  it("uses generation for same-millisecond requests and still counts continuous failures", async () => {
    const binding = await createTemporaryBinding();

    try {
      const first = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:00.000Z",
      );
      const second = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:00.000Z",
      );

      await expect(recordRepresentativeMcpBindingFailure({
        observation: second,
        failureReason: "mcp_timeout",
      })).resolves.toBe(true);
      await expect(recordRepresentativeMcpBindingSuccess({
        observation: first,
      })).resolves.toBe(false);

      const third = await beginObservation(
        binding.id,
        binding.configRevision,
        "2026-07-23T12:00:01.000Z",
      );
      await expect(recordRepresentativeMcpBindingFailure({
        observation: third,
        failureReason: "mcp_server_unavailable",
      })).resolves.toBe(true);

      const current = await loadHealth(binding.id);
      expect(current.consecutiveFailures).toBe(2);
      expect(current.lastFailureReason).toBe("mcp_server_unavailable");
      expect(current.lastHealthObservationGeneration).toBe(third.requestGeneration);
    } finally {
      await deleteTemporaryBinding(binding.id);
    }
  });
});

async function beginObservation(
  bindingId: string,
  configRevision: number,
  startedAt: string,
) {
  const observation = await beginRepresentativeMcpBindingHealthObservation({
    bindingId,
    configRevision,
    startedAt: new Date(startedAt),
  });
  if (!observation) {
    throw new Error("Expected the health observation to be claimed.");
  }
  return observation;
}

async function createTemporaryBinding() {
  const representative = await prisma.representative.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true },
  });
  if (!representative) {
    throw new Error("MCP health PostgreSQL E2E requires one seeded representative.");
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return prisma.representativeMcpBinding.create({
    data: {
      representativeId: representative.id,
      slug: `mcp-health-${suffix}`,
      displayName: "MCP health concurrency probe",
      serverUrl: "https://mcp.example.com/mcp",
      allowedToolNames: ["lookup"],
      defaultToolName: "lookup",
      enabled: true,
      approvalRequired: true,
      maxRetries: 0,
      retryBackoffMs: 100,
    },
    include: {
      representative: {
        select: { slug: true },
      },
    },
  });
}

async function loadHealth(bindingId: string) {
  return prisma.representativeMcpBinding.findUniqueOrThrow({
    where: { id: bindingId },
    select: {
      configRevision: true,
      healthRequestGeneration: true,
      lastHealthObservationGeneration: true,
      lastHealthObservationStartedAt: true,
      consecutiveFailures: true,
      lastFailureAt: true,
      lastFailureReason: true,
      lastSuccessAt: true,
    },
  });
}

async function deleteTemporaryBinding(id: string) {
  await prisma.representativeMcpBinding.delete({ where: { id } }).catch(() => undefined);
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the MCP health PostgreSQL E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
