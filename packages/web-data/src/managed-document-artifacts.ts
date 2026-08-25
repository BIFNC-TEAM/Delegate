import {
  ArtifactKind,
  ConversationPlanActionStatus,
  ConversationTurnPlanStatus,
  GenerationRunStatus,
  Prisma,
} from "@prisma/client";
import sha256Digest from "fast-sha256";

import {
  getArtifactStoreBucket,
  readArtifactObject,
  writeArtifactObject,
} from "./artifact-store";
import { prisma } from "./prisma";

const managedDocumentCapabilityKey = "artifact.generate_document";
const managedDocumentClaimKind = "managed_document_claim_v1";

export type ManagedConversationDocumentClaim = {
  planActionId: string;
  generationRunId: string;
  argumentsHash: string;
  claimToken: string;
  artifactId: string;
  objectKey: string;
  format: "markdown" | "txt";
};

export type ManagedConversationDocumentGenerationLease = {
  outboxId: string;
  leaseAttempt: number;
};

export type ManagedConversationDocumentResult = {
  artifact: {
    id: string;
    representativeId: string;
    conversationId: string | null;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  };
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
};

export async function prepareManagedConversationDocumentArtifact(input: {
  representativeId: string;
  representativeSlug: string;
  conversationId: string;
  generationRunId: string;
  planActionId: string;
  generationWorkLease: ManagedConversationDocumentGenerationLease;
}): Promise<
  | { status: "claimed"; claim: ManagedConversationDocumentClaim }
  | { status: "succeeded"; result: ManagedConversationDocumentResult }
> {
  return prisma.$transaction(async (tx) => {
    await lockManagedDocumentAction(tx, input.planActionId);
    const action = await loadManagedDocumentAction(tx, input.planActionId);
    assertManagedDocumentCoordinate(action, input);
    await assertManagedDocumentGenerationFence(
      tx,
      action,
      input.generationWorkLease,
    );
    const format = readManagedDocumentFormat(action.arguments);
    const claim = buildManagedDocumentClaim({
      representativeId: input.representativeId,
      conversationId: input.conversationId,
      generationRunId: input.generationRunId,
      planActionId: input.planActionId,
      argumentsHash: action.argumentsHash,
      format,
    });
    if (action.status === ConversationPlanActionStatus.SUCCEEDED) {
      return {
        status: "succeeded" as const,
        result: await loadSucceededManagedDocumentResult(
          tx,
          action,
          input,
          claim,
        ),
      };
    }
    if (
      action.turnPlan.status !== ConversationTurnPlanStatus.VALIDATED
      && action.turnPlan.status !== ConversationTurnPlanStatus.EXECUTING
    ) {
      throw new Error("Managed document plan is not executable.");
    }

    if (action.status === ConversationPlanActionStatus.EXECUTING) {
      if (
        action.turnPlan.protocolVersion === 3
        && !isStoredManagedDocumentClaim(action.expectedOutput)
      ) {
        const activeAttempt = action.executionAttempts[0];
        if (
          !activeAttempt
          || activeAttempt.status !== "RUNNING"
          || !activeAttempt.executionOutboxId
          || activeAttempt.executionEpoch !== action.turnPlan.executionEpoch
        ) {
          throw new Error("Managed document V3 action has no active execution admission.");
        }
        await tx.conversationPlanAction.update({
          where: { id: action.id },
          data: { expectedOutput: serializeStoredClaim(claim, null) },
        });
        return { status: "claimed" as const, claim };
      }
      assertStoredClaimMatches(action.expectedOutput, claim);
      return { status: "claimed" as const, claim };
    }
    if (action.status !== ConversationPlanActionStatus.READY) {
      throw new Error("Managed document action is not ready to execute.");
    }

    const claimedAt = new Date();
    const claimed = await tx.conversationPlanAction.updateMany({
      where: {
        id: input.planActionId,
        status: ConversationPlanActionStatus.READY,
        argumentsHash: action.argumentsHash,
      },
      data: {
        status: ConversationPlanActionStatus.EXECUTING,
        expectedOutput: serializeStoredClaim(claim, null),
        attemptCount: { increment: 1 },
        startedAt: action.startedAt ?? claimedAt,
        completedAt: null,
        failedAt: null,
      },
    });
    if (claimed.count !== 1) {
      throw new Error("Managed document action changed while claiming execution.");
    }
    await tx.conversationTurnPlan.updateMany({
      where: {
        id: action.turnPlan.id,
        status: ConversationTurnPlanStatus.VALIDATED,
      },
      data: {
        status: ConversationTurnPlanStatus.EXECUTING,
        startedAt: action.turnPlan.startedAt ?? claimedAt,
      },
    });
    return { status: "claimed" as const, claim };
  });
}

export async function createManagedConversationDocumentArtifact(input: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null;
  conversationId: string;
  generationRunId?: string;
  planActionId: string;
  claim?: ManagedConversationDocumentClaim;
  generationWorkLease?: ManagedConversationDocumentGenerationLease;
  title: string;
  format: "markdown" | "txt";
  content: string;
  retentionDays?: number;
}): Promise<ManagedConversationDocumentResult> {
  const claim = input.claim;
  if (!claim || !input.generationRunId || !input.generationWorkLease) {
    throw new Error("Managed document action must be prepared before artifact creation.");
  }
  if (
    claim.planActionId !== input.planActionId
    || claim.generationRunId !== input.generationRunId
    || claim.format !== input.format
  ) {
    throw new Error("Managed document claim does not match the requested artifact.");
  }
  let content = input.content.trim();
  if (!content) throw new Error("Managed document content is empty.");
  let body: Buffer = Buffer.from(content, "utf8");
  let sha256 = hashBytes(body);
  const mimeType = input.format === "markdown"
    ? "text/markdown; charset=utf-8"
    : "text/plain; charset=utf-8";
  const fileName = buildManagedDocumentFileName(input.title, input.format);

  const reservation = await prisma.$transaction(async (tx) => {
    await lockManagedDocumentAction(tx, input.planActionId);
    const action = await loadManagedDocumentAction(tx, input.planActionId);
    assertManagedDocumentCoordinate(action, {
      representativeId: input.representativeId,
      conversationId: input.conversationId,
      generationRunId: input.generationRunId!,
      planActionId: input.planActionId,
    });
    await assertManagedDocumentGenerationFence(
      tx,
      action,
      input.generationWorkLease!,
    );
    if (action.status === ConversationPlanActionStatus.SUCCEEDED) {
      return {
        status: "succeeded" as const,
        result: await loadSucceededManagedDocumentResult(
          tx,
          action,
          input,
          claim,
        ),
      };
    }
    if (action.status !== ConversationPlanActionStatus.EXECUTING) {
      throw new Error("Managed document artifact requires an executing action.");
    }
    const storedClaim = assertStoredClaimMatches(action.expectedOutput, claim);
    return storedClaim.contentSha256
      ? {
          status: "resume" as const,
          contentSha256: storedClaim.contentSha256,
        }
      : { status: "write" as const };
  });
  if (reservation.status === "succeeded") return reservation.result;

  if (reservation.status === "resume") {
    const staged = await readArtifactObject(claim.objectKey);
    const stagedSha256 = hashBytes(staged.buffer);
    if (stagedSha256 !== reservation.contentSha256) {
      throw new Error(
        "Managed document staged object does not match its reserved content hash.",
      );
    }
    body = staged.buffer;
    content = body.toString("utf8");
    sha256 = stagedSha256;
  } else {
    // Stage the stable object before recording its content hash. A crash after
    // the write can safely overwrite the unbound staging coordinate; once the
    // hash is recorded, retries read and commit this exact body.
    await writeArtifactObject({
      objectKey: claim.objectKey,
      body,
      contentType: mimeType,
    });
    await prisma.$transaction(async (tx) => {
      await lockManagedDocumentAction(tx, input.planActionId);
      const action = await loadManagedDocumentAction(tx, input.planActionId);
      assertManagedDocumentCoordinate(action, {
        representativeId: input.representativeId,
        conversationId: input.conversationId,
        generationRunId: input.generationRunId!,
        planActionId: input.planActionId,
      });
      await assertManagedDocumentGenerationFence(
        tx,
        action,
        input.generationWorkLease!,
      );
      if (action.status !== ConversationPlanActionStatus.EXECUTING) {
        throw new Error("Managed document action changed before staging commit.");
      }
      const storedClaim = assertStoredClaimMatches(action.expectedOutput, claim);
      if (
        storedClaim.contentSha256
        && storedClaim.contentSha256 !== sha256
      ) {
        throw new Error(
          "Managed document content reservation changed before staging commit.",
        );
      }
      if (!storedClaim.contentSha256) {
        await tx.conversationPlanAction.update({
          where: { id: action.id },
          data: { expectedOutput: serializeStoredClaim(claim, sha256) },
        });
      }
    });
  }

  return prisma.$transaction(async (tx) => {
    await lockManagedDocumentAction(tx, input.planActionId);
    const action = await loadManagedDocumentAction(tx, input.planActionId);
    assertManagedDocumentCoordinate(action, {
      representativeId: input.representativeId,
      conversationId: input.conversationId,
      generationRunId: input.generationRunId!,
      planActionId: input.planActionId,
    });
    await assertManagedDocumentGenerationFence(
      tx,
      action,
      input.generationWorkLease!,
    );
    if (action.status === ConversationPlanActionStatus.SUCCEEDED) {
      return loadSucceededManagedDocumentResult(tx, action, input, claim);
    }
    if (action.status !== ConversationPlanActionStatus.EXECUTING) {
      throw new Error("Managed document action changed before artifact commit.");
    }
    const storedClaim = assertStoredClaimMatches(action.expectedOutput, claim);
    if (storedClaim.contentSha256 !== sha256) {
      throw new Error("Managed document content reservation changed before commit.");
    }

    const retentionUntil = new Date(
      Date.now()
      + Math.max(1, input.retentionDays ?? 30) * 24 * 60 * 60 * 1_000,
    );
    const stored = await tx.artifact.upsert({
      where: { id: claim.artifactId },
      create: {
        id: claim.artifactId,
        representativeId: input.representativeId,
        contactId: input.contactId ?? null,
        conversationId: input.conversationId,
        kind: ArtifactKind.FILE,
        bucket: getArtifactStoreBucket(),
        objectKey: claim.objectKey,
        mimeType,
        sizeBytes: body.byteLength,
        sha256,
        retentionUntil,
        summary: `${fileName}: ${content.slice(0, 240)}`,
      },
      update: {
        objectKey: claim.objectKey,
        mimeType,
        sizeBytes: body.byteLength,
        sha256,
        retentionUntil,
        summary: `${fileName}: ${content.slice(0, 240)}`,
      },
    });
    if (
      stored.representativeId !== input.representativeId
      || stored.conversationId !== input.conversationId
      || stored.objectKey !== claim.objectKey
      || stored.sha256 !== sha256
    ) {
      throw new Error("Managed document artifact coordinate does not match its action.");
    }
    const completedAt = new Date();
    const completed = await tx.conversationPlanAction.updateMany({
      where: {
        id: input.planActionId,
        status: ConversationPlanActionStatus.EXECUTING,
        argumentsHash: claim.argumentsHash,
      },
      data: {
        status: action.turnPlan.protocolVersion === 3
          ? ConversationPlanActionStatus.EXECUTING
          : ConversationPlanActionStatus.SUCCEEDED,
        expectedOutput: action.turnPlan.protocolVersion === 3
          ? {
              ...serializeStoredClaim(claim, sha256),
              artifactId: stored.id,
              fileName,
            }
          : {
              artifactId: stored.id,
              fileName,
            },
        completedAt: action.turnPlan.protocolVersion === 3 ? null : completedAt,
        failedAt: null,
      },
    });
    if (completed.count !== 1) {
      throw new Error("Managed document action changed while committing its artifact.");
    }
    return buildManagedDocumentResult({
      artifact: stored,
      fileName,
      representativeSlug: input.representativeSlug,
    });
  });
}

type ManagedDocumentActionRecord = Awaited<
  ReturnType<typeof loadManagedDocumentAction>
>;

async function lockManagedDocumentAction(
  tx: Prisma.TransactionClient,
  planActionId: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${planActionId}))
  `;
}

async function loadManagedDocumentAction(
  tx: Prisma.TransactionClient,
  planActionId: string,
) {
  const action = await tx.conversationPlanAction.findUnique({
    where: { id: planActionId },
    include: {
      turnPlan: {
        select: {
          id: true,
          representativeId: true,
          conversationId: true,
          generationRunId: true,
          generationRun: { select: { status: true } },
          status: true,
          startedAt: true,
          protocolVersion: true,
          scopeKey: true,
          revision: true,
          executionEpoch: true,
        },
      },
      executionAttempts: {
        where: { status: "RUNNING" },
        orderBy: { attemptNumber: "desc" },
        take: 1,
      },
    },
  });
  if (!action) throw new Error("Managed document action was not found.");
  return action;
}

async function assertManagedDocumentGenerationFence(
  tx: Prisma.TransactionClient,
  action: ManagedDocumentActionRecord,
  lease: ManagedConversationDocumentGenerationLease,
) {
  if (action.turnPlan.protocolVersion === 3) {
    if (!action.turnPlan.scopeKey) {
      throw new Error("Managed document V3 plan scope is missing.");
    }
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${action.turnPlan.scopeKey}))
    `;
    const fence = await tx.planExecutionFence.findUnique({
      where: { scopeKey: action.turnPlan.scopeKey },
    });
    if (
      !fence
      || fence.activePlanId !== action.turnPlan.id
      || fence.activeRevision !== action.turnPlan.revision
      || fence.executionEpoch !== action.turnPlan.executionEpoch
    ) {
      throw new Error("Managed document V3 plan fence was superseded.");
    }
  }
  if (
    action.turnPlan.generationRun?.status !== GenerationRunStatus.PROCESSING
  ) {
    throw new Error("Managed document generation run is no longer executable.");
  }
  const outbox = await tx.outboxEvent.findUnique({
    where: { id: lease.outboxId },
    select: {
      aggregateType: true,
      aggregateId: true,
      eventType: true,
      status: true,
      attemptCount: true,
      availableAt: true,
    },
  });
  if (
    !outbox
    || outbox.aggregateType !== "generation_run"
    || outbox.aggregateId !== action.turnPlan.generationRunId
    || outbox.eventType !== "generation.requested"
    || outbox.status !== "PROCESSING"
    || outbox.attemptCount !== lease.leaseAttempt
    || outbox.availableAt.getTime() <= Date.now()
  ) {
    throw new Error("Managed document generation work lease was lost.");
  }
}

function assertManagedDocumentCoordinate(
  action: ManagedDocumentActionRecord,
  input: {
    representativeId: string;
    conversationId: string;
    generationRunId: string;
    planActionId: string;
  },
) {
  if (
    action.id !== input.planActionId
    || action.capabilityKey !== managedDocumentCapabilityKey
    || action.turnPlan.representativeId !== input.representativeId
    || action.turnPlan.conversationId !== input.conversationId
    || action.turnPlan.generationRunId !== input.generationRunId
  ) {
    throw new Error("Managed document action coordinate does not match its plan and run.");
  }
}

function buildManagedDocumentClaim(input: {
  representativeId: string;
  conversationId: string;
  generationRunId: string;
  planActionId: string;
  argumentsHash: string;
  format: "markdown" | "txt";
}): ManagedConversationDocumentClaim {
  const coordinateHash = hashText(`managed-document:v1:${input.planActionId}`);
  const artifactId = `managed_${coordinateHash.slice(0, 28)}`;
  const extension = input.format === "markdown" ? "md" : "txt";
  return {
    planActionId: input.planActionId,
    generationRunId: input.generationRunId,
    argumentsHash: input.argumentsHash,
    claimToken: hashText(
      `managed-document-claim:v1:${input.planActionId}:${input.generationRunId}:${input.argumentsHash}`,
    ),
    artifactId,
    objectKey: [
      "managed-documents",
      sanitizePathSegment(input.representativeId),
      sanitizePathSegment(input.conversationId),
      `${artifactId}.${extension}`,
    ].join("/"),
    format: input.format,
  };
}

function serializeStoredClaim(
  claim: ManagedConversationDocumentClaim,
  contentSha256: string | null,
): Prisma.InputJsonObject {
  return {
    kind: managedDocumentClaimKind,
    generationRunId: claim.generationRunId,
    argumentsHash: claim.argumentsHash,
    claimTokenHash: hashText(claim.claimToken),
    artifactId: claim.artifactId,
    objectKey: claim.objectKey,
    format: claim.format,
    contentSha256,
  };
}

function assertStoredClaimMatches(
  value: Prisma.JsonValue | null,
  claim: ManagedConversationDocumentClaim,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed document execution claim is missing.");
  }
  const stored = value as Record<string, unknown>;
  if (
    stored["kind"] !== managedDocumentClaimKind
    || stored["generationRunId"] !== claim.generationRunId
    || stored["argumentsHash"] !== claim.argumentsHash
    || stored["claimTokenHash"] !== hashText(claim.claimToken)
    || stored["artifactId"] !== claim.artifactId
    || stored["objectKey"] !== claim.objectKey
    || stored["format"] !== claim.format
  ) {
    throw new Error("Managed document execution claim does not match.");
  }
  const contentSha256 = stored["contentSha256"];
  if (contentSha256 !== null && typeof contentSha256 !== "string") {
    throw new Error("Managed document execution claim content hash is invalid.");
  }
  return { contentSha256 };
}

function isStoredManagedDocumentClaim(value: Prisma.JsonValue | null) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>)["kind"] === managedDocumentClaimKind,
  );
}

async function loadSucceededManagedDocumentResult(
  tx: Prisma.TransactionClient,
  action: ManagedDocumentActionRecord,
  input: {
    representativeId: string;
    representativeSlug: string;
    conversationId: string;
  },
  expectedClaim: ManagedConversationDocumentClaim,
): Promise<ManagedConversationDocumentResult> {
  const output = action.expectedOutput;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Succeeded managed document action has no output binding.");
  }
  const artifactId = output["artifactId"];
  const fileName = output["fileName"];
  if (
    typeof artifactId !== "string"
    || typeof fileName !== "string"
    || artifactId !== expectedClaim.artifactId
  ) {
    throw new Error("Succeeded managed document output binding is invalid.");
  }
  const artifact = await tx.artifact.findUnique({ where: { id: artifactId } });
  if (
    !artifact
    || artifact.representativeId !== input.representativeId
    || artifact.conversationId !== input.conversationId
    || artifact.objectKey !== expectedClaim.objectKey
  ) {
    throw new Error("Succeeded managed document artifact is outside its plan coordinate.");
  }
  return buildManagedDocumentResult({
    artifact,
    fileName,
    representativeSlug: input.representativeSlug,
  });
}

function buildManagedDocumentResult(input: {
  artifact: {
    id: string;
    representativeId: string;
    conversationId: string | null;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  };
  fileName: string;
  representativeSlug: string;
}): ManagedConversationDocumentResult {
  return {
    artifact: input.artifact,
    fileName: input.fileName,
    mimeType: input.artifact.mimeType,
    sizeBytes: input.artifact.sizeBytes,
    sha256: input.artifact.sha256,
    downloadUrl:
      `/reps/${encodeURIComponent(input.representativeSlug)}`
      + `/chat/artifacts/${encodeURIComponent(input.artifact.id)}/download`,
  };
}

function readManagedDocumentFormat(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed document action arguments are invalid.");
  }
  const format = value["format"];
  if (format === "markdown" || format === "txt") return format;
  throw new Error("Managed document action format is unsupported.");
}

function buildManagedDocumentFileName(
  title: string,
  format: "markdown" | "txt",
) {
  const base = title.trim()
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\r\n]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    || "document";
  return `${base}.${format === "markdown" ? "md" : "txt"}`;
}

function sanitizePathSegment(value: string) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120)
    || "unknown";
}

function hashText(value: string) {
  return hashBytes(new TextEncoder().encode(value));
}

function hashBytes(value: Uint8Array) {
  return Array.from(
    sha256Digest(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
