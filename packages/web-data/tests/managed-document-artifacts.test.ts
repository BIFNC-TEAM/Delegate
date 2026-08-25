import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, artifactStore } = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    conversationPlanAction: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationTurnPlan: { updateMany: vi.fn() },
    planExecutionFence: { findUnique: vi.fn() },
    outboxEvent: { findUnique: vi.fn() },
    artifact: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    mockPrisma: {
      ...tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx)),
    },
    artifactStore: {
      writeArtifactObject: vi.fn(),
      readArtifactObject: vi.fn(),
      getArtifactStoreBucket: vi.fn(() => "artifacts"),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../src/artifact-store", () => artifactStore);

describe("managed document artifacts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback) =>
      callback(mockPrisma));
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue(
      readyAction(),
    );
    mockPrisma.conversationPlanAction.update.mockResolvedValue({
      id: "plan-action-1",
    });
    mockPrisma.conversationPlanAction.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.conversationTurnPlan.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.outboxEvent.findUnique.mockResolvedValue({
      aggregateType: "generation_run",
      aggregateId: "run-1",
      eventType: "generation.requested",
      status: "PROCESSING",
      attemptCount: 1,
      availableAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.planExecutionFence.findUnique.mockResolvedValue({
      activePlanId: "plan-1",
      activeRevision: 1,
      executionEpoch: 1,
    });
    mockPrisma.artifact.upsert.mockImplementation(async ({ create }) => create);
    artifactStore.getArtifactStoreBucket.mockReturnValue("artifacts");
    artifactStore.readArtifactObject.mockResolvedValue({
      buffer: Buffer.from("# 地理学习教程\n\n完整正文", "utf8"),
    });
  });

  it("claims READY exactly once and binds a stable action-scoped artifact coordinate", async () => {
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    const prepared = await prepareManagedConversationDocumentArtifact(
      prepareInput(),
    );

    expect(prepared.status).toBe("claimed");
    if (prepared.status !== "claimed") throw new Error("claim missing");
    expect(prepared.claim).toMatchObject({
      planActionId: "plan-action-1",
      generationRunId: "run-1",
      argumentsHash: "a".repeat(64),
      format: "markdown",
      artifactId: expect.stringMatching(/^managed_[a-f0-9]{28}$/),
      objectKey: expect.stringMatching(
        /^managed-documents\/rep-1\/conversation-1\/managed_[a-f0-9]{28}\.md$/,
      ),
    });
    expect(mockPrisma.conversationPlanAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "plan-action-1",
        status: "READY",
        argumentsHash: "a".repeat(64),
      },
      data: expect.objectContaining({
        status: "EXECUTING",
        attemptCount: { increment: 1 },
        expectedOutput: expect.objectContaining({
          kind: "managed_document_claim_v1",
          artifactId: prepared.claim.artifactId,
          contentSha256: null,
        }),
      }),
    });
  });

  it("returns the already-bound artifact when the action already succeeded", async () => {
    const artifact = storedArtifact();
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue(
      succeededAction(artifact),
    );
    mockPrisma.artifact.findUnique.mockResolvedValue(artifact);
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    const prepared = await prepareManagedConversationDocumentArtifact(
      prepareInput(),
    );

    expect(prepared).toMatchObject({
      status: "succeeded",
      result: {
        artifact: { id: artifact.id },
        fileName: "地理学习教程.md",
      },
    });
    expect(mockPrisma.conversationPlanAction.updateMany).not.toHaveBeenCalled();
  });

  it("replays the same claim while the same action is already executing", async () => {
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );
    const first = await prepareManagedConversationDocumentArtifact(prepareInput());
    if (first.status !== "claimed") throw new Error("claim missing");
    const claimSnapshot = mockPrisma.conversationPlanAction.updateMany.mock.calls[0]![0]
      .data.expectedOutput;
    mockPrisma.conversationPlanAction.updateMany.mockClear();
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue(
      executingAction(claimSnapshot),
    );

    const replay = await prepareManagedConversationDocumentArtifact(prepareInput());

    expect(replay).toEqual(first);
    expect(mockPrisma.conversationPlanAction.updateMany).not.toHaveBeenCalled();
  });

  it("initializes a V3 claim only under the current Plan fence and admitted attempt", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      ...executingAction({ type: "object" }),
      executionAttempts: [{
        id: "attempt-v3",
        status: "RUNNING",
        executionOutboxId: "execution-outbox-v3",
        executionEpoch: 1,
      }],
      turnPlan: {
        ...readyAction().turnPlan,
        protocolVersion: 3,
        scopeKey: "generation:conversation-1:message-1",
        revision: 1,
        executionEpoch: 1,
      },
    });
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    const prepared = await prepareManagedConversationDocumentArtifact(prepareInput());

    expect(prepared.status).toBe("claimed");
    expect(mockPrisma.planExecutionFence.findUnique).toHaveBeenCalledWith({
      where: { scopeKey: "generation:conversation-1:message-1" },
    });
    expect(mockPrisma.conversationPlanAction.update).toHaveBeenCalledWith({
      where: { id: "plan-action-1" },
      data: {
        expectedOutput: expect.objectContaining({
          kind: "managed_document_claim_v1",
        }),
      },
    });
  });

  it("rejects a V3 artifact commit after plan supersession", async () => {
    mockPrisma.planExecutionFence.findUnique.mockResolvedValue({
      activePlanId: "plan-new",
      activeRevision: 2,
      executionEpoch: 2,
    });
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      ...executingAction({ type: "object" }),
      executionAttempts: [{
        id: "attempt-v3",
        status: "RUNNING",
        executionOutboxId: "execution-outbox-v3",
        executionEpoch: 1,
      }],
      turnPlan: {
        ...readyAction().turnPlan,
        protocolVersion: 3,
        scopeKey: "generation:conversation-1:message-1",
        revision: 1,
        executionEpoch: 1,
      },
    });
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    await expect(prepareManagedConversationDocumentArtifact(prepareInput()))
      .rejects.toThrow("plan fence was superseded");
    expect(mockPrisma.conversationPlanAction.update).not.toHaveBeenCalled();
  });

  it("rejects a claim outside the plan conversation and run coordinate", async () => {
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue({
      ...readyAction(),
      turnPlan: { ...readyAction().turnPlan, generationRunId: "run-other" },
    });
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    await expect(prepareManagedConversationDocumentArtifact(prepareInput()))
      .rejects.toThrow("coordinate does not match its plan and run");
    expect(mockPrisma.conversationPlanAction.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a stale generation work lease before claiming the action", async () => {
    mockPrisma.outboxEvent.findUnique.mockResolvedValue({
      aggregateType: "generation_run",
      aggregateId: "run-1",
      eventType: "generation.requested",
      status: "PROCESSING",
      attemptCount: 2,
      availableAt: new Date(Date.now() + 60_000),
    });
    const { prepareManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    await expect(prepareManagedConversationDocumentArtifact(prepareInput()))
      .rejects.toThrow("work lease was lost");
    expect(mockPrisma.conversationPlanAction.updateMany).not.toHaveBeenCalled();
  });

  it("commits only an EXECUTING claim and keeps object identity stable across retries", async () => {
    const { prepareManagedConversationDocumentArtifact,
      createManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );
    const prepared = await prepareManagedConversationDocumentArtifact(
      prepareInput(),
    );
    if (prepared.status !== "claimed") throw new Error("claim missing");
    const claimSnapshot = mockPrisma.conversationPlanAction.updateMany.mock.calls[0]![0]
      .data.expectedOutput;
    const content = "# 地理学习教程\n\n完整正文";
    const contentSha256 = sha256(content.trim());
    mockPrisma.conversationPlanAction.findUnique
      .mockResolvedValueOnce(executingAction(claimSnapshot))
      .mockResolvedValueOnce(executingAction(claimSnapshot))
      .mockResolvedValueOnce(executingAction({
        ...claimSnapshot,
        contentSha256,
      }));

    const result = await createManagedConversationDocumentArtifact({
      ...createInput(),
      claim: prepared.claim,
      content,
    });

    expect(artifactStore.writeArtifactObject).toHaveBeenCalledWith({
      objectKey: prepared.claim.objectKey,
      contentType: "text/markdown; charset=utf-8",
      body: expect.any(Buffer),
    });
    expect(mockPrisma.artifact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: prepared.claim.artifactId },
        create: expect.objectContaining({
          id: prepared.claim.artifactId,
          objectKey: prepared.claim.objectKey,
          sha256: contentSha256,
        }),
      }),
    );
    expect(result.artifact.id).toBe(prepared.claim.artifactId);
  });

  it("resumes the staged original instead of overwriting it with changed retry content", async () => {
    const { prepareManagedConversationDocumentArtifact,
      createManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );
    const prepared = await prepareManagedConversationDocumentArtifact(
      prepareInput(),
    );
    if (prepared.status !== "claimed") throw new Error("claim missing");
    const claimSnapshot = mockPrisma.conversationPlanAction.updateMany.mock.calls[0]![0]
      .data.expectedOutput;
    const firstContentHash = sha256("first content");
    const reservedClaim = {
      ...claimSnapshot,
      contentSha256: firstContentHash,
    };
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue(
      executingAction(reservedClaim),
    );
    artifactStore.readArtifactObject.mockResolvedValue({
      buffer: Buffer.from("first content", "utf8"),
    });

    await expect(createManagedConversationDocumentArtifact({
      ...createInput(),
      claim: prepared.claim,
      content: "different content",
    })).resolves.toMatchObject({ sha256: firstContentHash });
    expect(artifactStore.writeArtifactObject).not.toHaveBeenCalled();
    expect(mockPrisma.artifact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sha256: firstContentHash }),
      }),
    );
  });

  it("returns the committed artifact without writing the object again", async () => {
    const { prepareManagedConversationDocumentArtifact,
      createManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );
    const prepared = await prepareManagedConversationDocumentArtifact(
      prepareInput(),
    );
    if (prepared.status !== "claimed") throw new Error("claim missing");
    const artifact = storedArtifact();
    mockPrisma.conversationPlanAction.findUnique.mockResolvedValue(
      succeededAction(artifact),
    );
    mockPrisma.artifact.findUnique.mockResolvedValue(artifact);
    artifactStore.writeArtifactObject.mockClear();

    const result = await createManagedConversationDocumentArtifact({
      ...createInput(),
      claim: prepared.claim,
      content: "same retry body",
    });

    expect(result.artifact.id).toBe(artifact.id);
    expect(artifactStore.writeArtifactObject).not.toHaveBeenCalled();
  });

  it("requires prepare/claim before object storage", async () => {
    const { createManagedConversationDocumentArtifact } = await import(
      "../src/managed-document-artifacts"
    );

    await expect(createManagedConversationDocumentArtifact({
      ...createInput(),
      content: "正文",
    })).rejects.toThrow("must be prepared");
    expect(artifactStore.writeArtifactObject).not.toHaveBeenCalled();
  });
});

function prepareInput() {
  return {
    representativeId: "rep-1",
    representativeSlug: "geography-rep",
    conversationId: "conversation-1",
    generationRunId: "run-1",
    planActionId: "plan-action-1",
    generationWorkLease: { outboxId: "outbox-1", leaseAttempt: 1 },
  };
}

function createInput() {
  return {
    ...prepareInput(),
    contactId: "contact-1",
    title: "地理学习教程",
    format: "markdown" as const,
    retentionDays: 30,
  };
}

function readyAction() {
  return {
    id: "plan-action-1",
    capabilityKey: "artifact.generate_document",
    status: "READY",
    arguments: { topic: "地理学习教程", format: "markdown" },
    argumentsHash: "a".repeat(64),
    expectedOutput: null,
    startedAt: null,
    turnPlan: {
      id: "plan-1",
      representativeId: "rep-1",
      conversationId: "conversation-1",
      generationRunId: "run-1",
      generationRun: { status: "PROCESSING" },
      status: "VALIDATED",
      startedAt: null,
    },
  };
}

function executingAction(expectedOutput: unknown) {
  return {
    ...readyAction(),
    status: "EXECUTING",
    expectedOutput,
  };
}

function succeededAction(artifact: ReturnType<typeof storedArtifact>) {
  return {
    ...readyAction(),
    status: "SUCCEEDED",
    expectedOutput: {
      artifactId: artifact.id,
      fileName: "地理学习教程.md",
    },
  };
}

function storedArtifact() {
  const artifactId = `managed_${sha256("managed-document:v1:plan-action-1").slice(0, 28)}`;
  return {
    id: artifactId,
    representativeId: "rep-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    sessionId: null,
    toolExecutionId: null,
    delegationTaskId: null,
    delegationTaskStepId: null,
    kind: "FILE",
    bucket: "artifacts",
    objectKey: `managed-documents/rep-1/conversation-1/${artifactId}.md`,
    mimeType: "text/markdown; charset=utf-8",
    sizeBytes: 128,
    sha256: "b".repeat(64),
    isPinned: false,
    pinnedAt: null,
    pinnedBy: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    retentionUntil: new Date("2026-09-17T00:00:00.000Z"),
    summary: "地理学习教程.md",
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
    updatedAt: new Date("2026-08-17T00:00:00.000Z"),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
