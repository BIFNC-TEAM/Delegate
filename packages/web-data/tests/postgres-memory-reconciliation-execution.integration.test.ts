import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { applyAutomaticMemoryPolicyInTransaction } from "../src/memory-governance";
import {
  runNextMemoryProjectionDeletion,
  runNextMemoryProjectionWrite,
  type MemoryProjectionProvider,
} from "../src/memory-projection-execution";
import {
  OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
  runNextMemoryReconciliation,
  type MemoryReconciliationProvider,
} from "../src/memory-reconciliation-execution";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory reconciliation PostgreSQL execution", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires issue evidence before fencing and closes a missing repair", async () => {
    const provider = new ExactMemoryProvider();
    const fixture = await createActiveFixture(provider, "missing");
    provider.objects.delete(fixture.remoteUri);

    await expect(prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: {
        status: "RETRYING",
        availableAt: new Date(),
        lastErrorCode: "reconciliation_missing_remote",
      },
    })).rejects.toThrow();

    const result = await reconcile(provider, fixture.representativeId);
    expect(result).toMatchObject({
      processed: true,
      status: "partial",
      known: { issues: 1 },
      errorCode: OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
    });
    const runId = requireRunId(result);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, lastErrorCode: true },
    })).resolves.toEqual({
      status: "RETRYING",
      lastErrorCode: "reconciliation_missing_remote",
    });
    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: { reconciliationRunId: runId, projectionItemId: fixture.projectionId },
      select: { issueKind: true, status: true, resolvedAt: true },
    })).resolves.toEqual({
      issueKind: "MISSING_REMOTE",
      status: "OPEN",
      resolvedAt: null,
    });
    await expect(prisma.memoryReconciliationRun.update({
      where: { id: runId },
      data: { resolvedCount: 1 },
    })).rejects.toThrow();
    await expect(prisma.memoryReconciliationRun.update({
      where: { id: runId },
      data: { observedCount: 1, matchedCount: 1 },
    })).rejects.toThrow();
    await expect(prisma.memoryReconciliationItem.create({
      data: {
        reconciliationRunId: runId,
        representativeId: fixture.representativeId,
        projectionItemId: fixture.projectionId,
        itemKey: `forged:${randomUUID()}`,
        issueKind: "MISSING_REMOTE",
        expectedContentHash: fixture.contentHash,
        remoteObjectIdHash: createHash("sha256")
          .update(fixture.remoteUri)
          .digest("hex"),
        reasonCode: "reconciliation_missing_remote",
      },
    })).rejects.toThrow();

    await expect(runNextMemoryProjectionWrite({ client: prisma, provider }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: { reconciliationRunId: runId, projectionItemId: fixture.projectionId },
      select: { status: true, resolvedAt: true },
    })).resolves.toEqual({ status: "RESOLVED", resolvedAt: expect.any(Date) });
    await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { issueCount: true, resolvedCount: true },
    })).resolves.toEqual({ issueCount: 1, resolvedCount: 1 });
    await expect(prisma.memoryReconciliationItem.update({
      where: {
        reconciliationRunId_itemKey: {
          reconciliationRunId: runId,
          itemKey: `known_projection:${fixture.projectionId}`,
        },
      },
      data: { status: "OPEN", resolvedAt: null },
    })).rejects.toThrow();
  });

  it("turns a CAS miss into IGNORED plus SKIPPED without mutating the moving projection", async () => {
    const provider = new ExactMemoryProvider();
    const fixture = await createActiveFixture(provider, "cas-miss");
    provider.objects.delete(fixture.remoteUri);
    provider.onInspect = async () => {
      provider.onInspect = null;
      await prisma.memoryProjectionItem.update({
        where: { id: fixture.projectionId },
        data: { status: "SUPERSEDED" },
      });
    };

    const result = await reconcile(provider, fixture.representativeId);
    const runId = requireRunId(result);
    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: { reconciliationRunId: runId, projectionItemId: fixture.projectionId },
      select: { status: true, resolvedAt: true, lastErrorCode: true },
    })).resolves.toEqual({
      status: "IGNORED",
      resolvedAt: expect.any(Date),
      lastErrorCode: "reconciliation_moving_target",
    });
    await expect(prisma.memoryReconciliationTarget.findUniqueOrThrow({
      where: {
        reconciliationRunId_projectionItemId: {
          reconciliationRunId: runId,
          projectionItemId: fixture.projectionId,
        },
      },
      select: { status: true, lastErrorCode: true },
    })).resolves.toEqual({
      status: "SKIPPED",
      lastErrorCode: "reconciliation_moving_target",
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, lastErrorCode: true },
    })).resolves.toEqual({ status: "SUPERSEDED", lastErrorCode: null });
    expect(provider.deleteCalls).toBe(0);
    await expect(prisma.memoryReconciliationItem.updateMany({
      where: { reconciliationRunId: runId, projectionItemId: fixture.projectionId },
      data: { attemptCount: 1 },
    })).rejects.toThrow();
  });

  it("skips a live in-flight writer without probing or reporting it missing", async () => {
    const provider = new ExactMemoryProvider();
    const fixture = await createAutomaticallyActivatedFixture("live");
    provider.blockNextEnsure();
    const writer = runNextMemoryProjectionWrite({ client: prisma, provider });
    await provider.ensureStarted.promise;

    const result = await reconcile(provider, fixture.representativeId);
    const runId = requireRunId(result);
    expect(provider.inspectCalls).toBe(0);
    await expect(prisma.memoryReconciliationTarget.findUniqueOrThrow({
      where: {
        reconciliationRunId_projectionItemId: {
          reconciliationRunId: runId,
          projectionItemId: fixture.projectionId,
        },
      },
      select: { kind: true, status: true, lastErrorCode: true },
    })).resolves.toEqual({
      kind: "LIVE_IN_FLIGHT",
      status: "SKIPPED",
      lastErrorCode: "reconciliation_live_projection_skipped",
    });
    await expect(prisma.memoryReconciliationItem.count({
      where: { reconciliationRunId: runId },
    })).resolves.toBe(0);

    provider.releaseEnsure();
    await expect(writer).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
  });

  it("is idempotent within a periodic bucket and records only partial truth", async () => {
    const provider = new ExactMemoryProvider();
    const fixture = await createActiveFixture(provider, "periodic");
    const now = new Date("2026-08-04T08:00:00.000Z");

    const first = await reconcile(provider, fixture.representativeId, now);
    const second = await runNextMemoryReconciliation({
      client: prisma,
      provider,
      now: () => now,
      reconciliationIntervalMilliseconds: 300_000,
    });
    const runId = requireRunId(first);

    expect(first).toMatchObject({
      status: "partial",
      inventoryStatus: "partial",
      remoteEnumeration: "unsupported",
      known: { matched: 1, issues: 0 },
    });
    if (second.processed) {
      await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
        where: { id: second.runId },
        select: { representativeId: true },
      })).resolves.not.toEqual({ representativeId: fixture.representativeId });
    }
    await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        representativeId: true,
        idempotencyKey: true,
        status: true,
        errorCode: true,
      },
    })).resolves.toEqual({
      representativeId: fixture.representativeId,
      idempotencyKey: `periodic:${Math.floor(now.getTime() / 300_000)}`,
      status: "PARTIAL",
      errorCode: OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
    });
    await expect(prisma.memoryReconciliationRun.count({
      where: {
        representativeId: fixture.representativeId,
        idempotencyKey: `periodic:${Math.floor(now.getTime() / 300_000)}`,
      },
    })).resolves.toBe(1);
    expect(provider.deleteCalls).toBe(0);
  });

  it("closes known-stale evidence only after confirmed exact deletion", async () => {
    const provider = new ExactMemoryProvider();
    const fixture = await createActiveFixture(provider, "stale");
    await prisma.memoryProjectionItem.update({
      where: { id: fixture.projectionId },
      data: { status: "SUPERSEDED" },
    });

    const result = await reconcile(provider, fixture.representativeId);
    const runId = requireRunId(result);
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true },
    })).resolves.toEqual({ status: "DELETE_PENDING" });
    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: { reconciliationRunId: runId, projectionItemId: fixture.projectionId },
      select: { issueKind: true, status: true },
    })).resolves.toEqual({ issueKind: "STALE_ACTIVE_POINTER", status: "OPEN" });

    await expect(runNextMemoryProjectionDeletion({ client: prisma, provider }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, deleteReceiptHash: true, remoteAbsentAt: true },
    })).resolves.toMatchObject({
      status: "DELETED",
      deleteReceiptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      remoteAbsentAt: expect.any(Date),
    });
    await expect(prisma.memoryReconciliationItem.findFirstOrThrow({
      where: { reconciliationRunId: runId, projectionItemId: fixture.projectionId },
      select: { status: true, resolvedAt: true },
    })).resolves.toEqual({ status: "RESOLVED", resolvedAt: expect.any(Date) });
    await expect(prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { issueCount: true, resolvedCount: true },
    })).resolves.toEqual({ issueCount: 1, resolvedCount: 1 });
    expect(provider.deleteCalls).toBe(1);
  });

  it("retains reversible suppression and reuses the same ACTIVE projection after restore", async () => {
    const provider = new ExactMemoryProvider();
    const fixture = await createActiveFixture(provider, "restore");
    const inspectedBefore = provider.inspectedUris.length;
    const suppressedAt = new Date();
    await prisma.governedMemory.update({
      where: { id: fixture.memoryId },
      data: {
        status: "SUPPRESSED",
        recallDisabledAt: suppressedAt,
        suppressedAt,
      },
    });

    const inactive = await reconcile(
      provider,
      fixture.representativeId,
      new Date("2026-08-04T08:00:00.000Z"),
    );
    const inactiveRunId = requireRunId(inactive);
    expect(provider.inspectedUris.slice(inspectedBefore)).not.toContain(
      fixture.remoteUri,
    );
    await expect(prisma.memoryReconciliationTarget.findUniqueOrThrow({
      where: {
        reconciliationRunId_projectionItemId: {
          reconciliationRunId: inactiveRunId,
          projectionItemId: fixture.projectionId,
        },
      },
      select: { kind: true, status: true },
    })).resolves.toEqual({ kind: "RETAINED_INACTIVE", status: "SKIPPED" });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, deleteRequestedAt: true },
    })).resolves.toEqual({ status: "ACTIVE", deleteRequestedAt: null });
    expect(provider.deleteCalls).toBe(0);

    await prisma.governedMemory.update({
      where: { id: fixture.memoryId },
      data: { status: "ACTIVE", recallDisabledAt: null },
    });
    const restored = await reconcile(
      provider,
      fixture.representativeId,
      new Date("2026-08-04T09:05:00.000Z"),
    );
    expect(restored).toMatchObject({
      processed: true,
      known: { matched: 1, issues: 0 },
    });
    await expect(prisma.memoryProjectionItem.findUniqueOrThrow({
      where: { id: fixture.projectionId },
      select: { status: true, remoteUri: true },
    })).resolves.toEqual({ status: "ACTIVE", remoteUri: fixture.remoteUri });
    expect(provider.deleteCalls).toBe(0);
  });
});

class ExactMemoryProvider
implements MemoryProjectionProvider, MemoryReconciliationProvider {
  readonly name = "reconciliation-test";
  readonly objects = new Map<string, string>();
  inspectCalls = 0;
  readonly inspectedUris: string[] = [];
  deleteCalls = 0;
  onInspect: (() => Promise<void>) | null = null;
  ensureStarted = deferred<void>();
  private ensureRelease: ReturnType<typeof deferred<void>> | null = null;

  blockNextEnsure() {
    this.ensureStarted = deferred<void>();
    this.ensureRelease = deferred<void>();
  }

  releaseEnsure() {
    this.ensureRelease?.resolve(undefined);
    this.ensureRelease = null;
  }

  async ensureRoot(input: { rootUri: string }) {
    if (this.ensureRelease) {
      const release = this.ensureRelease;
      this.ensureStarted.resolve(undefined);
      await release.promise;
    }
    return { rootUri: input.rootUri, receipt: `ensure:${input.rootUri}` };
  }

  async writeExact(input: { uri: string; contentHash: string }) {
    this.objects.set(input.uri, input.contentHash);
    return {
      uri: input.uri,
      contentHash: input.contentHash,
      receipt: `write:${input.uri}:${input.contentHash}`,
    };
  }

  async inspectExact(input: { uri: string }) {
    this.inspectCalls += 1;
    this.inspectedUris.push(input.uri);
    await this.onInspect?.();
    const contentHash = this.objects.get(input.uri);
    return contentHash
      ? {
          uri: input.uri,
          exists: true,
          contentHash,
          receipt: `inspect:present:${input.uri}:${contentHash}`,
        }
      : {
          uri: input.uri,
          exists: false,
          receipt: `inspect:absent:${input.uri}`,
        };
  }

  async deleteExact(input: { uri: string }) {
    this.deleteCalls += 1;
    const existed = this.objects.delete(input.uri);
    const outcome = existed ? "deleted" as const : "absent" as const;
    return {
      uri: input.uri,
      outcome,
      receipt: `delete:${outcome}:${input.uri}`,
    };
  }
}

async function createActiveFixture(provider: ExactMemoryProvider, label: string) {
  const fixture = await createAutomaticallyActivatedFixture(label);
  const result = await runNextMemoryProjectionWrite({
    client: prisma,
    provider,
    representativeId: fixture.representativeId,
  });
  if (!result.processed || result.status !== "completed") {
    throw new Error(`Projection activation failed: ${JSON.stringify(result)}`);
  }
  return fixture;
}

async function createAutomaticallyActivatedFixture(label: string) {
  const suffix = randomUUID();
  const owner = await prisma.owner.create({
    data: { displayName: `Reconciliation owner ${label} ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `reconciliation-${label}-${suffix}`,
      displayName: "Reconciliation representative",
      roleSummary: "Tests exact-only governed memory reconciliation.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  await prisma.representativeMemoryPolicy.create({
    data: {
      representativeId: representative.id,
      namespaceKey: `reconciliation-${suffix}`,
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: false,
      autoExtract: true,
      webRecallEnabled: true,
      webExtractEnabled: true,
      provider: "reconciliation-test",
    },
  });
  const contact = await prisma.contact.create({
    data: { representativeId: representative.id, sourceChannel: "WEB" },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "WEB",
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "AUDIENCE",
      text: "I prefer concise replies",
    },
  });
  const safeText = "Preference: reply_length=concise";
  const contentHash = createHash("sha256").update(safeText).digest("hex");
  const candidate = await prisma.memoryCandidate.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      scope: "CONTACT_CHANNEL",
      scopeChannel: "WEB",
      originChannel: "WEB",
      category: "CONTACT_PREFERENCE",
      sourceKind: "AUDIENCE_MESSAGE",
      safeText,
      summary: safeText,
      contentHash,
      semanticKey: "contact-preference:communication",
      dedupeKey: `candidate-${suffix}`,
      status: "PENDING_REVIEW",
      safetyClass: "LOW_RISK",
      extractionReasonCode: "explicit_contact_preference",
      sourceContactId: contact.id,
      sourceConversationId: conversation.id,
      sourceMessageId: message.id,
    },
  });
  const activated = await prisma.$transaction((tx) =>
    applyAutomaticMemoryPolicyInTransaction(tx, {
      candidateId: candidate.id,
      sourceHash: createHash("sha256")
        .update(message.text ?? "")
        .digest("hex"),
      confidence: 1,
    }),
  );
  if (!activated.memoryId || !activated.memoryVersionId) {
    throw new Error("Automatic policy did not create governed memory coordinates.");
  }
  const projection = await prisma.memoryProjectionItem.findFirstOrThrow({
    where: {
      memoryId: activated.memoryId,
      memoryVersionId: activated.memoryVersionId,
    },
  });
  return {
    representativeId: representative.id,
    memoryId: activated.memoryId,
    projectionId: projection.id,
    remoteUri: projection.remoteUri,
    contentHash,
  };
}

async function reconcile(
  provider: ExactMemoryProvider,
  representativeId: string,
  now = new Date("2026-08-04T08:00:00.000Z"),
) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const result = await runNextMemoryReconciliation({
      client: prisma,
      provider,
      now: () => now,
      reconciliationIntervalMilliseconds: 300_000,
    });
    if (!result.processed) continue;
    const run = await prisma.memoryReconciliationRun.findUniqueOrThrow({
      where: { id: result.runId },
      select: { representativeId: true },
    });
    if (run.representativeId !== representativeId) continue;
    if (result.status === "requeued") continue;
    return result;
  }
  throw new Error(`Reconciliation did not finish for ${representativeId}.`);
}

function requireRunId(
  result: Awaited<ReturnType<typeof runNextMemoryReconciliation>>,
) {
  if (!result.processed) throw new Error("Expected reconciliation work.");
  return result.runId;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for reconciliation PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing reconciliation PostgreSQL E2E against ${host}/${database}.`);
  }
}
