import {
  creatorTrainingReviewDedupeKey,
  creatorTrainingReviewSubjectId,
  getWorkflowEngineConfig,
  resolveWorkflowDispatchTarget,
  shouldDispatchWorkflowViaTemporalOutbox,
} from "@delegate/workflows";
import { demoRepresentative } from "@delegate/domain";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { prisma } from "./prisma";
import {
  acquireRepresentativeKnowledgePackLock,
  type RepresentativeKnowledgePackLockClient,
} from "./knowledge-pack-lock";

export type CreatorTrainingSourceKind =
  | "url"
  | "pdf"
  | "text"
  | "notion"
  | "drive"
  | "website";

export type CreatorTrainingSourceStatus = "draft" | "active" | "disabled" | "failed";
export type CreatorFeedbackSignalType =
  | "approve"
  | "correction"
  | "do_not_say"
  | "suggested_answer";
export type CreatorTrainingSuggestionType =
  | "faq_update"
  | "policy_update"
  | "material_update"
  | "tone_rule"
  | "skill_recommendation"
  | "knowledge_gap";
export type CreatorTrainingSuggestionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "private"
  | "published"
  | "superseded";
export type CreatorTrainingReviewAction = "approve" | "reject" | "private";

export type CreatorTrainingEvaluationReport = {
  outcome: "passed" | "failed";
  checks: Array<{
    name: string;
    passed: boolean;
    severity: "info" | "warning" | "critical";
    message: string;
  }>;
};

export type CreatorTrainingSourceSnapshot = {
  id: string;
  representativeId: string;
  kind: CreatorTrainingSourceKind;
  status: CreatorTrainingSourceStatus;
  title: string;
  locator: string | null;
  contentText: string | null;
  metadata: unknown;
  lastSyncedAt: string | null;
  errorReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type CreatorTrainingSourceRecord = {
  id: string;
  representativeId: string;
  kind: string;
  status: string;
  title: string;
  locator: string | null;
  contentText: string | null;
  metadata: unknown;
  lastSyncedAt: Date | null;
  errorReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CreatorFeedbackSignalRecord = {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  turnId: string | null;
  signalType: string;
  status: string;
  publicSafe: boolean;
  note: string | null;
  suggestedText: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CreatorTrainingSuggestionRecord = {
  id: string;
  representativeId: string;
  originKey: string;
  originRevision: number;
  sourceId: string | null;
  feedbackSignalId: string | null;
  suggestionType: string;
  status: string;
  title: string;
  rationale: string;
  draftPayload: unknown;
  dedupeKey: string;
  riskLevel: string;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type UnknownQuestionTurnRecord = {
  messageText: string;
  conversationId: string;
  createdAt: Date;
};

export type CreatorFeedbackSignalSnapshot = {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  turnId: string | null;
  signalType: CreatorFeedbackSignalType;
  status: string;
  publicSafe: boolean;
  note: string | null;
  suggestedText: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatorTrainingSuggestionSnapshot = {
  id: string;
  representativeId: string;
  originKey: string;
  originRevision: number;
  sourceId: string | null;
  feedbackSignalId: string | null;
  suggestionType: CreatorTrainingSuggestionType;
  status: CreatorTrainingSuggestionStatus;
  title: string;
  rationale: string;
  draftPayload: unknown;
  dedupeKey: string;
  riskLevel: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatorTrainingVersionSnapshot = {
  id: string;
  representativeId: string;
  revisionNumber: number;
  suggestionId: string | null;
  status: "published" | "rolled_back";
  title: string;
  snapshotBefore: unknown;
  snapshotAfter: unknown;
  evaluationReport: unknown;
  publishedBy: string | null;
  publishedAt: string;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  createdAt: string;
};

export type CreatorTrainingReviewWorkflowSnapshot = {
  id: string;
  workflowKind: "creator_training_review";
  engine: "local_runner" | "temporal";
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  dedupeKey: string;
  queueName: string | null;
  externalWorkflowId: string | null;
  scheduledAt: string;
  nextWakeAt: string | null;
  createdAt: string;
};

export type CreatorTrainingDashboardSnapshot = {
  sources: CreatorTrainingSourceSnapshot[];
  feedbackSignals: CreatorFeedbackSignalSnapshot[];
  suggestions: CreatorTrainingSuggestionSnapshot[];
  versions: CreatorTrainingVersionSnapshot[];
  latestWorkflow: CreatorTrainingReviewWorkflowSnapshot | null;
  summary: {
    availableSourceCount: number;
    pendingFeedbackCount: number;
    pendingSuggestionCount: number;
    appliedVersionCount: number;
  };
};

type RepresentativeLookupClient = {
  representative: {
    findUnique(args: {
      where: { slug: string };
      select: { id: true; slug: true };
    }): Promise<{ id: string; slug: string } | null>;
  };
};

type CreatorFeedbackSignalClient = RepresentativeLookupClient & {
  contact: {
    findFirst(args: {
      where: { id: string; representativeId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  conversation: {
    findFirst(args: {
      where: { id: string; representativeId: string };
      select: { id: true; contactId: true };
    }): Promise<{ id: string; contactId: string } | null>;
  };
  conversationTurn: {
    findFirst(args: {
      where: { id: string; conversation: { representativeId: string } };
      select: { id: true; conversationId: true };
    }): Promise<{ id: string; conversationId: string } | null>;
  };
  creatorFeedbackSignal: {
    create(args: {
      data: {
        representativeId: string;
        contactId?: string | null;
        conversationId?: string | null;
        turnId?: string | null;
        signalType: "APPROVE" | "CORRECTION" | "DO_NOT_SAY" | "SUGGESTED_ANSWER";
        publicSafe?: boolean;
        note?: string | null;
        suggestedText?: string | null;
        createdBy?: string | null;
      };
    }): Promise<CreatorFeedbackSignalRecord>;
    findMany(args: {
      where: {
        representativeId: string;
        status?: string | undefined;
      };
      orderBy: Array<{ createdAt: "desc" }>;
      take: number;
    }): Promise<CreatorFeedbackSignalRecord[]>;
  };
};

type CreatorTrainingSourceClient = RepresentativeLookupClient & {
  creatorTrainingSource: {
    create(args: {
      data: {
        representativeId: string;
        kind: Uppercase<CreatorTrainingSourceKind>;
        status?: "DRAFT" | "ACTIVE" | "DISABLED" | "FAILED";
        title: string;
        locator?: string | null;
        contentText?: string | null;
        metadata?: unknown;
        createdBy?: string | null;
      };
    }): Promise<CreatorTrainingSourceRecord>;
    findMany(args: {
      where: {
        representativeId: string;
        status?: { not: "DISABLED" } | undefined;
      };
      orderBy: Array<{ updatedAt: "desc" } | { createdAt: "desc" }>;
    }): Promise<CreatorTrainingSourceRecord[]>;
    findFirst(args: {
      where: {
        id: string;
        representativeId: string;
      };
    }): Promise<CreatorTrainingSourceRecord | null>;
    update(args: {
      where: { id: string };
      data: Partial<{
        kind: Uppercase<CreatorTrainingSourceKind>;
        status: "DRAFT" | "ACTIVE" | "DISABLED" | "FAILED";
        title: string;
        locator: string | null;
        contentText: string | null;
        metadata: unknown;
        errorReason: string | null;
      }>;
    }): Promise<CreatorTrainingSourceRecord>;
  };
};

type CreatorTrainingSuggestionClient = RepresentativeLookupClient &
  RepresentativeKnowledgePackLockClient & {
  $transaction?: <T>(
    callback: (client: CreatorTrainingSuggestionClient) => Promise<T>,
  ) => Promise<T>;
  creatorTrainingSource: {
    findMany(args: {
      where: {
        representativeId: string;
        status?: { not: "DISABLED" } | undefined;
      };
      orderBy: Array<{ updatedAt: "desc" } | { createdAt: "desc" }>;
      take: number;
    }): Promise<CreatorTrainingSourceRecord[]>;
  };
  creatorFeedbackSignal: {
    findMany(args: {
      where: {
        representativeId: string;
        status?: string | undefined;
      };
      orderBy: Array<{ createdAt: "desc" }>;
      take: number;
    }): Promise<CreatorFeedbackSignalRecord[]>;
  };
  conversationTurn: {
    findMany(args: {
      where: {
        direction: string;
        intent: string;
        conversation: {
          representativeId: string;
        };
      };
      select: {
        messageText: true;
        conversationId: true;
        createdAt: true;
      };
      orderBy: Array<{ createdAt: "desc" }>;
      take: number;
    }): Promise<UnknownQuestionTurnRecord[]>;
  };
  creatorTrainingVersion: {
    findFirst(args: {
      where: {
        representativeId: string;
        status: "PUBLISHED";
        suggestion: {
          is: {
            originKey: string;
          };
        };
      };
      orderBy: {
        revisionNumber: "desc";
      };
      select: {
        suggestion: true;
      };
    }): Promise<{ suggestion: CreatorTrainingSuggestionRecord | null } | null>;
  };
  creatorTrainingSuggestion: {
    findFirst(args: {
      where: {
        representativeId: string;
        originKey: string;
        status?: "PUBLISHED" | undefined;
      };
      orderBy: {
        originRevision: "desc";
      };
    }): Promise<CreatorTrainingSuggestionRecord | null>;
    updateMany(args: {
      where: {
        representativeId: string;
        originKey: string;
        status: "PENDING";
        id?: {
          not: string;
        };
      };
      data: {
        status: "SUPERSEDED";
      };
    }): Promise<{ count: number }>;
    create(args: {
      data: {
        representativeId: string;
        originKey: string;
        originRevision: number;
        sourceId?: string | null;
        feedbackSignalId?: string | null;
        suggestionType: "FAQ_UPDATE" | "POLICY_UPDATE" | "MATERIAL_UPDATE" | "TONE_RULE" | "SKILL_RECOMMENDATION" | "KNOWLEDGE_GAP";
        status: "PENDING";
        title: string;
        rationale: string;
        draftPayload: unknown;
        dedupeKey: string;
        riskLevel: string;
      };
    }): Promise<CreatorTrainingSuggestionRecord>;
    findMany(args: {
      where: {
        representativeId: string;
        status?: "PENDING" | "APPROVED" | "REJECTED" | "PRIVATE" | "PUBLISHED" | "SUPERSEDED" | undefined;
      };
      orderBy: Array<{ createdAt: "desc" }>;
      take: number;
    }): Promise<CreatorTrainingSuggestionRecord[]>;
  };
};

type KnowledgePackRecord = {
  representativeId: string;
  identitySummary: string;
  faq: unknown;
  materials: unknown;
  policies: unknown;
};

type CreatorTrainingVersionRecord = {
  id: string;
  representativeId: string;
  revisionNumber: number;
  suggestionId: string | null;
  status: string;
  title: string;
  snapshotBefore: unknown;
  snapshotAfter: unknown;
  evaluationReport: unknown;
  publishedBy: string | null;
  publishedAt: Date;
  rolledBackBy: string | null;
  rolledBackAt: Date | null;
  createdAt: Date;
};

type CreatorTrainingWorkflowRecord = {
  id: string;
  kind: string;
  engine: string;
  status: string;
  dedupeKey: string;
  queueName: string | null;
  externalWorkflowId: string | null;
  scheduledAt: Date;
  nextWakeAt: Date | null;
  createdAt: Date;
};

type CreatorTrainingReviewClient = RepresentativeLookupClient & RepresentativeKnowledgePackLockClient & {
  $transaction?: <T>(callback: (client: CreatorTrainingReviewClient) => Promise<T>) => Promise<T>;
  creatorTrainingSource: {
    update(args: {
      where: { id: string };
      data: {
        status: "ACTIVE";
      };
    }): Promise<CreatorTrainingSourceRecord>;
  };
  creatorTrainingSuggestion: {
    findFirst(args: {
      where: { id: string; representativeId: string };
    }): Promise<CreatorTrainingSuggestionRecord | null>;
    findMany(args: {
      where: {
        representativeId: string;
        originKey: string;
      };
      select: {
        id: true;
        draftPayload: true;
      };
    }): Promise<Array<Pick<CreatorTrainingSuggestionRecord, "id" | "draftPayload">>>;
    updateMany(args: {
      where: {
        id: string;
        representativeId: string;
        status: "PENDING";
      };
      data: {
        status: "APPROVED" | "REJECTED" | "PRIVATE";
        reviewedAt: Date;
        reviewedBy?: string | null;
        reviewNote?: string | null;
        draftPayload?: unknown;
      };
    }): Promise<{ count: number }>;
    update(args: {
      where: { id: string };
      data: {
        status: "APPROVED" | "REJECTED" | "PRIVATE" | "PUBLISHED";
        reviewedAt: Date;
        reviewedBy?: string | null;
        reviewNote?: string | null;
        draftPayload?: unknown;
      };
    }): Promise<CreatorTrainingSuggestionRecord>;
  };
  knowledgePack: {
    findUnique(args: {
      where: { representativeId: string };
    }): Promise<KnowledgePackRecord | null>;
    upsert(args: {
      where: { representativeId: string };
      update: {
        revision: {
          increment: 1;
        };
        identitySummary: string;
        faq: unknown;
        materials: unknown;
        policies: unknown;
      };
      create: {
        representativeId: string;
        revision: number;
        identitySummary: string;
        faq: unknown;
        materials: unknown;
        policies: unknown;
      };
    }): Promise<KnowledgePackRecord>;
  };
  creatorTrainingVersion: {
    findFirst(args: {
      where: {
        representativeId: string;
      };
      orderBy: {
        revisionNumber: "desc";
      };
      select: {
        revisionNumber: true;
      };
    }): Promise<Pick<CreatorTrainingVersionRecord, "revisionNumber"> | null>;
    create(args: {
      data: {
        representativeId: string;
        revisionNumber: number;
        suggestionId?: string | null;
        title: string;
        snapshotBefore: unknown;
        snapshotAfter: unknown;
        evaluationReport?: unknown;
        publishedBy?: string | null;
      };
    }): Promise<CreatorTrainingVersionRecord>;
  };
};

type CreatorTrainingWorkflowClient = RepresentativeLookupClient & {
  $transaction?: <T>(callback: (client: CreatorTrainingWorkflowClient) => Promise<T>) => Promise<T>;
  workflowRun: {
    findUnique(args: {
      where: { dedupeKey: string };
      select: CreatorTrainingWorkflowSelect;
    }): Promise<CreatorTrainingWorkflowRecord | null>;
    create(args: {
      data: {
        representativeId: string;
        kind: "CREATOR_TRAINING_REVIEW";
        engine: "TEMPORAL" | "LOCAL_RUNNER";
        status: "QUEUED";
        enginePhase?: "DISPATCH_PENDING";
        nextWakeAt?: Date;
        dedupeKey: string;
        queueName: string;
        externalWorkflowId: string;
        scheduledAt: Date;
        input: {
          representativeSlug: string;
          feedbackLimit?: number;
          unknownQuestionLimit?: number;
        };
        commandOutbox?: {
          create: {
            commandType: "START";
            payload: {
              source: string;
              scheduledAt: string;
            };
          };
        };
      };
      select: CreatorTrainingWorkflowSelect;
    }): Promise<CreatorTrainingWorkflowRecord>;
  };
  eventAudit: {
    create(args: {
      data: {
        representativeId: string;
        type: "WORKFLOW_ENQUEUED";
        payload: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
};

type CreatorTrainingWorkflowListClient = RepresentativeLookupClient & {
  workflowRun: {
    findFirst(args: {
      where: {
        representativeId: string;
        kind: "CREATOR_TRAINING_REVIEW";
      };
      orderBy: Array<{ scheduledAt: "desc" } | { createdAt: "desc" }>;
      select: CreatorTrainingWorkflowSelect;
    }): Promise<CreatorTrainingWorkflowRecord | null>;
  };
};

type CreatorTrainingVersionListClient = RepresentativeLookupClient & {
  creatorTrainingVersion: {
    findMany(args: {
      where: {
        representativeId: string;
      };
      orderBy: {
        revisionNumber: "desc";
      };
      take: number;
    }): Promise<CreatorTrainingVersionRecord[]>;
  };
};

type CreatorTrainingRollbackClient = RepresentativeLookupClient & RepresentativeKnowledgePackLockClient & {
  $transaction?: <T>(callback: (client: CreatorTrainingRollbackClient) => Promise<T>) => Promise<T>;
  knowledgePack: CreatorTrainingReviewClient["knowledgePack"];
  creatorTrainingVersion: {
    findMany(args: {
      where: {
        representativeId: string;
        status: "PUBLISHED";
      };
    }): Promise<CreatorTrainingVersionRecord[]>;
    findFirst(args: {
      where: {
        id?: string;
        representativeId: string;
        status?: "PUBLISHED";
      };
      orderBy?: {
        revisionNumber: "desc";
      };
    }): Promise<CreatorTrainingVersionRecord | null>;
    update(args: {
      where: { id: string };
      data: {
        status: "ROLLED_BACK";
        rolledBackBy?: string | null;
        rolledBackAt: Date;
      };
    }): Promise<CreatorTrainingVersionRecord>;
  };
};

export async function createCreatorTrainingSource(
  representativeSlug: string,
  input: {
    kind: string;
    title: string;
    locator?: string | null | undefined;
    contentText?: string | null | undefined;
    metadata?: unknown;
    createdBy?: string | null | undefined;
  },
  client: CreatorTrainingSourceClient = prisma as unknown as CreatorTrainingSourceClient,
): Promise<CreatorTrainingSourceSnapshot> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return createDemoCreatorTrainingSource(representativeSlug, input);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const normalized = normalizeSourceInput(input);
  const source = await client.creatorTrainingSource.create({
    data: {
      representativeId: representative.id,
      kind: mapSourceKindToDb(normalized.kind),
      title: normalized.title,
      ...(normalized.locator !== undefined ? { locator: normalized.locator } : {}),
      ...(normalized.contentText !== undefined ? { contentText: normalized.contentText } : {}),
      ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
      ...(normalized.createdBy !== undefined ? { createdBy: normalized.createdBy } : {}),
    },
  });

  return serializeCreatorTrainingSource(source);
}

export async function listCreatorTrainingSources(
  representativeSlug: string,
  client: CreatorTrainingSourceClient = prisma as unknown as CreatorTrainingSourceClient,
): Promise<CreatorTrainingSourceSnapshot[]> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return getDemoTrainingState().sources.map(cloneTrainingSource);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const sources = await client.creatorTrainingSource.findMany({
    where: {
      representativeId: representative.id,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });

  return sources.map(serializeCreatorTrainingSource);
}

export async function updateCreatorTrainingSource(
  representativeSlug: string,
  sourceId: string,
  input: {
    kind?: string | undefined;
    status?: string | undefined;
    title?: string | undefined;
    locator?: string | null | undefined;
    contentText?: string | null | undefined;
    metadata?: unknown;
    errorReason?: string | null | undefined;
  },
  client: CreatorTrainingSourceClient = prisma as unknown as CreatorTrainingSourceClient,
): Promise<CreatorTrainingSourceSnapshot> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return updateDemoCreatorTrainingSource(representativeSlug, sourceId, input);
  }

  const source = await requireSource(representativeSlug, sourceId, client);
  const data: Parameters<CreatorTrainingSourceClient["creatorTrainingSource"]["update"]>[0]["data"] = {};

  if (input.kind !== undefined) {
    data.kind = mapSourceKindToDb(normalizeSourceKind(input.kind));
  }
  if (input.status !== undefined) {
    data.status = mapSourceStatusToDb(normalizeSourceStatus(input.status));
  }
  if (input.title !== undefined) {
    data.title = normalizeRequiredText(input.title, "title");
  }
  if (input.locator !== undefined) {
    data.locator = normalizeNullableText(input.locator);
  }
  if (input.contentText !== undefined) {
    data.contentText = normalizeNullableText(input.contentText);
  }
  if (input.metadata !== undefined) {
    data.metadata = input.metadata;
  }
  if (input.errorReason !== undefined) {
    data.errorReason = normalizeNullableText(input.errorReason);
  }

  const updated = await client.creatorTrainingSource.update({
    where: { id: source.id },
    data,
  });

  return serializeCreatorTrainingSource(updated);
}

export async function disableCreatorTrainingSource(
  representativeSlug: string,
  sourceId: string,
  client: CreatorTrainingSourceClient = prisma as unknown as CreatorTrainingSourceClient,
): Promise<CreatorTrainingSourceSnapshot> {
  return updateCreatorTrainingSource(
    representativeSlug,
    sourceId,
    {
      status: "disabled",
    },
    client,
  );
}

export async function createCreatorFeedbackSignal(
  representativeSlug: string,
  input: {
    signalType: string;
    contactId?: string | null | undefined;
    conversationId?: string | null | undefined;
    turnId?: string | null | undefined;
    publicSafe?: boolean | undefined;
    note?: string | null | undefined;
    suggestedText?: string | null | undefined;
    createdBy?: string | null | undefined;
  },
  client: CreatorFeedbackSignalClient = prisma as unknown as CreatorFeedbackSignalClient,
): Promise<CreatorFeedbackSignalSnapshot> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return createDemoCreatorFeedbackSignal(representativeSlug, input);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const signalType = normalizeFeedbackSignalType(input.signalType);
  const scope = await resolveFeedbackScope(representative.id, input, client);

  const signal = await client.creatorFeedbackSignal.create({
    data: {
      representativeId: representative.id,
      ...(scope.contactId ? { contactId: scope.contactId } : {}),
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.turnId ? { turnId: scope.turnId } : {}),
      signalType: mapFeedbackSignalTypeToDb(signalType),
      publicSafe: Boolean(input.publicSafe),
      ...(input.note !== undefined ? { note: normalizeNullableText(input.note) } : {}),
      ...(input.suggestedText !== undefined
        ? { suggestedText: normalizeNullableText(input.suggestedText) }
        : {}),
      ...(input.createdBy !== undefined ? { createdBy: normalizeNullableText(input.createdBy) } : {}),
    },
  });

  return serializeCreatorFeedbackSignal(signal);
}

export async function listCreatorFeedbackSignals(
  representativeSlug: string,
  input: {
    status?: string | undefined;
    limit?: number | undefined;
  } = {},
  client: CreatorFeedbackSignalClient = prisma as unknown as CreatorFeedbackSignalClient,
): Promise<CreatorFeedbackSignalSnapshot[]> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return getDemoTrainingState().feedbackSignals
      .filter((signal) => !input.status || signal.status === input.status)
      .slice(0, input.limit ?? 50)
      .map(cloneFeedbackSignal);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const signals = await client.creatorFeedbackSignal.findMany({
    where: {
      representativeId: representative.id,
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: input.limit ?? 50,
  });

  return signals.map(serializeCreatorFeedbackSignal);
}

export async function buildCreatorTrainingSuggestions(
  representativeSlug: string,
  input: {
    feedbackLimit?: number | undefined;
    unknownQuestionLimit?: number | undefined;
    sourceLimit?: number | undefined;
  } = {},
  client: CreatorTrainingSuggestionClient = prisma as unknown as CreatorTrainingSuggestionClient,
): Promise<CreatorTrainingSuggestionSnapshot[]> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return buildDemoCreatorTrainingSuggestions(representativeSlug);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const requireAdvisoryLock = isProductionCreatorTrainingClient(client);
  const run = async (tx: CreatorTrainingSuggestionClient) => {
    await acquireRepresentativeKnowledgePackLock(
      tx,
      representative.id,
      { required: requireAdvisoryLock },
    );
    const feedbackSignals = await tx.creatorFeedbackSignal.findMany({
      where: {
        representativeId: representative.id,
        status: "new",
      },
      orderBy: [{ createdAt: "desc" }],
      take: input.feedbackLimit ?? 100,
    });
    const sources = await tx.creatorTrainingSource.findMany({
      where: {
        representativeId: representative.id,
        status: {
          not: "DISABLED",
        },
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: input.sourceLimit ?? 100,
    });
    const unknownTurns = await tx.conversationTurn.findMany({
      where: {
        direction: "inbound",
        intent: "unknown",
        conversation: {
          representativeId: representative.id,
        },
      },
      select: {
        messageText: true,
        conversationId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }],
      take: input.unknownQuestionLimit ?? 200,
    });
    const candidates = [
      ...sources.flatMap((source) => buildSourceSuggestionCandidates(source)),
      ...feedbackSignals.flatMap((signal) => buildFeedbackSuggestionCandidates(signal)),
      ...buildUnknownQuestionCandidates(unknownTurns),
    ];
    const suggestions: CreatorTrainingSuggestionSnapshot[] = [];

    for (const candidate of candidates) {
      const latestApplied = await tx.creatorTrainingVersion.findFirst({
        where: {
          representativeId: representative.id,
          status: "PUBLISHED",
          suggestion: {
            is: {
              originKey: candidate.originKey,
            },
          },
        },
        orderBy: { revisionNumber: "desc" },
        select: { suggestion: true },
      });
      const appliedSuggestion = latestApplied?.suggestion ?? null;
      const latest = await tx.creatorTrainingSuggestion.findFirst({
        where: {
          representativeId: representative.id,
          originKey: candidate.originKey,
        },
        orderBy: { originRevision: "desc" },
      });
      const latestStatus = latest ? mapSuggestionStatusFromDb(latest.status) : null;
      let current =
        latest
        && latest.dedupeKey === candidate.dedupeKey
        && latestStatus !== "superseded"
        && (
          latestStatus !== "published"
          || appliedSuggestion?.id === latest.id
        )
          ? latest
          : null;
      if (!current && appliedSuggestion?.dedupeKey === candidate.dedupeKey) {
        current = appliedSuggestion;
      }
      await tx.creatorTrainingSuggestion.updateMany({
        where: {
          representativeId: representative.id,
          originKey: candidate.originKey,
          status: "PENDING",
          ...(current && mapSuggestionStatusFromDb(current.status) === "pending"
            ? { id: { not: current.id } }
            : {}),
        },
        data: {
          status: "SUPERSEDED",
        },
      });
      if (current) {
        suggestions.push(serializeCreatorTrainingSuggestion(current));
        continue;
      }

      // A suggestion is the immutable payload that the owner reviews. Changed
      // evidence creates a successor and supersedes the prior pending draft.
      const suggestion = await tx.creatorTrainingSuggestion.create({
        data: {
          representativeId: representative.id,
          originKey: candidate.originKey,
          originRevision: (latest?.originRevision ?? 0) + 1,
          ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
          ...(candidate.feedbackSignalId ? { feedbackSignalId: candidate.feedbackSignalId } : {}),
          suggestionType: mapSuggestionTypeToDb(candidate.suggestionType),
          status: "PENDING",
          title: candidate.title,
          rationale: candidate.rationale,
          draftPayload: candidate.draftPayload,
          dedupeKey: candidate.dedupeKey,
          riskLevel: candidate.riskLevel,
        },
      });
      suggestions.push(serializeCreatorTrainingSuggestion(suggestion));
    }

    return suggestions;
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

export async function listCreatorTrainingSuggestions(
  representativeSlug: string,
  input: {
    status?: CreatorTrainingSuggestionStatus | undefined;
    limit?: number | undefined;
  } = {},
  client: CreatorTrainingSuggestionClient = prisma as unknown as CreatorTrainingSuggestionClient,
): Promise<CreatorTrainingSuggestionSnapshot[]> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return getDemoTrainingState().suggestions
      .filter((suggestion) => !input.status || suggestion.status === input.status)
      .slice(0, input.limit ?? 50)
      .map(cloneTrainingSuggestion);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const suggestions = await client.creatorTrainingSuggestion.findMany({
    where: {
      representativeId: representative.id,
      ...(input.status ? { status: mapSuggestionStatusToDb(input.status) } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: input.limit ?? 50,
  });

  return suggestions.map(serializeCreatorTrainingSuggestion);
}

export function evaluateCreatorTrainingDraftPayload(
  draftPayload: unknown,
): CreatorTrainingEvaluationReport {
  const searchableText = collectSearchableText(draftPayload).join(" ").toLowerCase();
  const checks: CreatorTrainingEvaluationReport["checks"] = [
    {
      name: "structured_payload",
      passed: isRecord(draftPayload),
      severity: "critical",
      message: "Draft payload must be a structured object before publishing.",
    },
    {
      name: "has_public_content",
      passed: searchableText.trim().length >= 8,
      severity: "critical",
      message: "Draft payload must contain enough creator-readable content to review.",
    },
    {
      name: "no_guaranteed_outcome_claims",
      passed: !containsGuaranteedOutcomeClaim(searchableText),
      severity: "critical",
      message: "Draft payload must not promise guaranteed revenue, outcomes, or earnings.",
    },
  ];

  return {
    outcome: checks.some((check) => !check.passed && check.severity === "critical")
      ? "failed"
      : "passed",
    checks,
  };
}

export async function reviewCreatorTrainingSuggestion(
  representativeSlug: string,
  suggestionId: string,
  input: {
    action: CreatorTrainingReviewAction;
    reviewedBy?: string | null | undefined;
    reviewNote?: string | null | undefined;
    editedDraftPayload?: unknown;
    now?: Date | undefined;
  },
  client: CreatorTrainingReviewClient = prisma as unknown as CreatorTrainingReviewClient,
): Promise<{
  suggestion: CreatorTrainingSuggestionSnapshot;
  version: CreatorTrainingVersionSnapshot | null;
}> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return reviewDemoCreatorTrainingSuggestion(representativeSlug, suggestionId, input);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const now = input.now ?? new Date();
  const action = normalizeReviewAction(input.action);
  const normalizedSuggestionId = normalizeRequiredText(suggestionId, "suggestionId");
  const requireAdvisoryLock = isProductionCreatorTrainingClient(client);
  const run = async (tx: CreatorTrainingReviewClient) => {
    await acquireRepresentativeKnowledgePackLock(
      tx,
      representative.id,
      { required: requireAdvisoryLock },
    );
    const suggestion = await tx.creatorTrainingSuggestion.findFirst({
      where: {
        id: normalizedSuggestionId,
        representativeId: representative.id,
      },
    });
    if (!suggestion) {
      throw new Error("Creator training suggestion not found.");
    }
    if (mapSuggestionStatusFromDb(suggestion.status) !== "pending") {
      throw new Error("Creator training suggestion is no longer pending.");
    }

    if (action === "reject" || action === "private") {
      const claimed = await tx.creatorTrainingSuggestion.updateMany({
        where: {
          id: suggestion.id,
          representativeId: representative.id,
          status: "PENDING",
        },
        data: {
          status: action === "reject" ? "REJECTED" : "PRIVATE",
          reviewedAt: now,
          ...(input.reviewedBy !== undefined
            ? { reviewedBy: normalizeNullableText(input.reviewedBy) }
            : {}),
          ...(input.reviewNote !== undefined
            ? { reviewNote: normalizeNullableText(input.reviewNote) }
            : {}),
        },
      });
      if (claimed.count !== 1) {
        throw new Error("Creator training suggestion is no longer pending.");
      }
      const reviewed = await tx.creatorTrainingSuggestion.findFirst({
        where: {
          id: suggestion.id,
          representativeId: representative.id,
        },
      });
      if (!reviewed) {
        throw new Error("Creator training suggestion not found after review.");
      }
      return {
        suggestion: serializeCreatorTrainingSuggestion(reviewed),
        version: null,
      };
    }

    const draftPayload =
      input.editedDraftPayload === undefined ? suggestion.draftPayload : input.editedDraftPayload;
    assertKnowledgeGapHasCreatorAnswer(suggestion.suggestionType, draftPayload);
    const evaluationReport = evaluateCreatorTrainingDraftPayload(draftPayload);
    if (!isEvaluationReportPassing(evaluationReport)) {
      throw new Error("Creator training evaluation failed.");
    }
    const originSuggestions = await tx.creatorTrainingSuggestion.findMany({
      where: {
        representativeId: representative.id,
        originKey: suggestion.originKey,
      },
      select: {
        id: true,
        draftPayload: true,
      },
    });
    const before = await loadKnowledgePackSnapshot(representative.id, tx);
    const after = applySuggestionToKnowledgePack(
      before,
      {
        ...suggestion,
        draftPayload,
      },
      originSuggestions,
    );
    const claimed = await tx.creatorTrainingSuggestion.updateMany({
      where: {
        id: suggestion.id,
        representativeId: representative.id,
        status: "PENDING",
      },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        ...(input.reviewedBy !== undefined
          ? { reviewedBy: normalizeNullableText(input.reviewedBy) }
          : {}),
        ...(input.reviewNote !== undefined
          ? { reviewNote: normalizeNullableText(input.reviewNote) }
          : {}),
        ...(input.editedDraftPayload !== undefined ? { draftPayload } : {}),
      },
    });
    if (claimed.count !== 1) {
      throw new Error("Creator training suggestion is no longer pending.");
    }
    await tx.knowledgePack.upsert({
      where: { representativeId: representative.id },
      update: {
        revision: { increment: 1 },
        identitySummary: after.identitySummary,
        faq: after.faq,
        materials: after.materials,
        policies: after.policies,
      },
      create: {
        representativeId: representative.id,
        revision: 1,
        identitySummary: after.identitySummary,
        faq: after.faq,
        materials: after.materials,
        policies: after.policies,
      },
    });
    if (suggestion.sourceId) {
      await tx.creatorTrainingSource.update({
        where: { id: suggestion.sourceId },
        data: { status: "ACTIVE" },
      });
    }
    const reviewed = await tx.creatorTrainingSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "PUBLISHED",
        reviewedAt: now,
        ...(input.reviewedBy !== undefined
          ? { reviewedBy: normalizeNullableText(input.reviewedBy) }
          : {}),
        ...(input.reviewNote !== undefined
          ? { reviewNote: normalizeNullableText(input.reviewNote) }
          : {}),
        ...(input.editedDraftPayload !== undefined ? { draftPayload } : {}),
      },
    });
    const latestVersion = await tx.creatorTrainingVersion.findFirst({
      where: {
        representativeId: representative.id,
      },
      orderBy: {
        revisionNumber: "desc",
      },
      select: {
        revisionNumber: true,
      },
    });
    const version = await tx.creatorTrainingVersion.create({
      data: {
        representativeId: representative.id,
        revisionNumber: (latestVersion?.revisionNumber ?? 0) + 1,
        suggestionId: suggestion.id,
        title: suggestion.title,
        snapshotBefore: before,
        snapshotAfter: after,
        evaluationReport,
        ...(input.reviewedBy !== undefined
          ? { publishedBy: normalizeNullableText(input.reviewedBy) }
          : {}),
      },
    });

    return {
      suggestion: serializeCreatorTrainingSuggestion(reviewed),
      version: serializeCreatorTrainingVersion(version),
    };
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

export async function listCreatorTrainingVersions(
  representativeSlug: string,
  input: {
    limit?: number | undefined;
  } = {},
  client: CreatorTrainingVersionListClient = prisma as unknown as CreatorTrainingVersionListClient,
): Promise<CreatorTrainingVersionSnapshot[]> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return getDemoTrainingState().versions.slice(0, input.limit ?? 20).map(cloneTrainingVersion);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const versions = await client.creatorTrainingVersion.findMany({
    where: {
      representativeId: representative.id,
    },
    orderBy: { revisionNumber: "desc" },
    take: input.limit ?? 20,
  });

  return versions.map(serializeCreatorTrainingVersion);
}

export async function getLatestCreatorTrainingReviewWorkflow(
  representativeSlug: string,
  client: CreatorTrainingWorkflowListClient = prisma as unknown as CreatorTrainingWorkflowListClient,
): Promise<CreatorTrainingReviewWorkflowSnapshot | null> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    const workflow = getDemoTrainingState().workflow;
    return workflow ? { ...workflow } : null;
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const workflow = await client.workflowRun.findFirst({
    where: {
      representativeId: representative.id,
      kind: "CREATOR_TRAINING_REVIEW",
    },
    orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }],
    select: creatorTrainingWorkflowSelect,
  });
  return workflow ? serializeCreatorTrainingReviewWorkflow(workflow) : null;
}

export async function getCreatorTrainingDashboardSnapshot(
  representativeSlug: string,
): Promise<CreatorTrainingDashboardSnapshot> {
  const [sources, feedbackSignals, suggestions, versions, latestWorkflow] = await Promise.all([
    listCreatorTrainingSources(representativeSlug),
    listCreatorFeedbackSignals(representativeSlug, { status: "new", limit: 50 }),
    listCreatorTrainingSuggestions(representativeSlug, { status: "pending", limit: 50 }),
    listCreatorTrainingVersions(representativeSlug, { limit: 20 }),
    getLatestCreatorTrainingReviewWorkflow(representativeSlug),
  ]);

  return {
    sources,
    feedbackSignals,
    suggestions,
    versions,
    latestWorkflow,
    summary: {
      availableSourceCount: sources.filter(
        (source) => source.status !== "disabled" && source.status !== "failed",
      ).length,
      pendingFeedbackCount: feedbackSignals.length,
      pendingSuggestionCount: suggestions.length,
      appliedVersionCount: versions.filter((version) => version.status === "published").length,
    },
  };
}

export async function rollbackCreatorTrainingVersion(
  representativeSlug: string,
  versionId: string,
  input: {
    now?: Date | undefined;
    rolledBackBy?: string | null | undefined;
  } = {},
  client: CreatorTrainingRollbackClient = prisma as unknown as CreatorTrainingRollbackClient,
): Promise<CreatorTrainingVersionSnapshot> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return rollbackDemoCreatorTrainingVersion(representativeSlug, versionId, input);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const now = input.now ?? new Date();
  const normalizedVersionId = normalizeRequiredText(versionId, "versionId");
  const requireAdvisoryLock = isProductionCreatorTrainingClient(client);
  const run = async (tx: CreatorTrainingRollbackClient) => {
    await acquireRepresentativeKnowledgePackLock(
      tx,
      representative.id,
      { required: requireAdvisoryLock },
    );
    const version = await tx.creatorTrainingVersion.findFirst({
      where: {
        id: normalizedVersionId,
        representativeId: representative.id,
      },
    });
    if (!version) {
      throw new Error("Creator training version not found.");
    }
    if (mapVersionStatusFromDb(version.status) === "rolled_back") {
      return serializeCreatorTrainingVersion(version);
    }

    const latestPublished = await tx.creatorTrainingVersion.findFirst({
      where: {
        representativeId: representative.id,
        status: "PUBLISHED",
      },
      orderBy: { revisionNumber: "desc" },
    });
    if (!latestPublished || latestPublished.id !== version.id) {
      throw new Error("Only the latest applied creator training version can be rolled back.");
    }

    const current = await loadKnowledgePackSnapshot(representative.id, tx);
    const matchingPublishedVersions = (
      await tx.creatorTrainingVersion.findMany({
        where: {
          representativeId: representative.id,
          status: "PUBLISHED",
        },
      })
    ).filter((candidate) =>
      knowledgePackSnapshotsEqual(
        normalizeKnowledgePackSnapshot(candidate.snapshotAfter),
        current,
      ),
    );
    if (matchingPublishedVersions.length > 1) {
      throw new Error(
        "Creator training history is ambiguous for the current knowledge draft. Publish a new update before rolling back.",
      );
    }
    const expectedCurrent = normalizeKnowledgePackSnapshot(version.snapshotAfter);
    if (!knowledgePackSnapshotsEqual(current, expectedCurrent)) {
      throw new Error(
        "Knowledge draft changed after this creator training version. Refresh before rolling back.",
      );
    }

    const before = normalizeKnowledgePackSnapshot(version.snapshotBefore);
    await tx.knowledgePack.upsert({
      where: { representativeId: representative.id },
      update: {
        revision: { increment: 1 },
        identitySummary: before.identitySummary,
        faq: before.faq,
        materials: before.materials,
        policies: before.policies,
      },
      create: {
        representativeId: representative.id,
        revision: 1,
        identitySummary: before.identitySummary,
        faq: before.faq,
        materials: before.materials,
        policies: before.policies,
      },
    });

    const updated = await tx.creatorTrainingVersion.update({
      where: { id: version.id },
      data: {
        status: "ROLLED_BACK",
        ...(input.rolledBackBy !== undefined
          ? { rolledBackBy: normalizeNullableText(input.rolledBackBy) }
          : {}),
        rolledBackAt: now,
      },
    });

    return serializeCreatorTrainingVersion(updated);
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

export async function enqueueCreatorTrainingReviewWorkflow(
  representativeSlug: string,
  input: {
    feedbackLimit?: number | undefined;
    unknownQuestionLimit?: number | undefined;
    now?: Date | undefined;
  } = {},
  client: CreatorTrainingWorkflowClient = prisma as unknown as CreatorTrainingWorkflowClient,
): Promise<CreatorTrainingReviewWorkflowSnapshot> {
  if (shouldUseStaticFallbackMode(representativeSlug)) {
    return enqueueDemoCreatorTrainingReviewWorkflow(representativeSlug, input);
  }

  const representative = await requireRepresentative(representativeSlug, client);
  const requestedAt = input.now ?? new Date();
  const dedupeKey = creatorTrainingReviewDedupeKey(representative.slug, requestedAt);
  const workflowInput = {
    representativeSlug: representative.slug,
    ...(input.feedbackLimit !== undefined ? { feedbackLimit: input.feedbackLimit } : {}),
    ...(input.unknownQuestionLimit !== undefined
      ? { unknownQuestionLimit: input.unknownQuestionLimit }
      : {}),
  };

  const run = async (tx: CreatorTrainingWorkflowClient) => {
    const existing = await tx.workflowRun.findUnique({
      where: { dedupeKey },
      select: creatorTrainingWorkflowSelect,
    });
    if (existing) {
      return serializeCreatorTrainingReviewWorkflow(existing);
    }

    const dispatchTarget = resolveWorkflowDispatchTarget({
      config: getWorkflowEngineConfig(),
      kind: "creator_training_review",
      representativeKey: representative.slug,
      subjectId: creatorTrainingReviewSubjectId(requestedAt),
    });
    const isTemporal = shouldDispatchWorkflowViaTemporalOutbox(dispatchTarget);
    const workflow = await tx.workflowRun.create({
      data: {
        representativeId: representative.id,
        kind: "CREATOR_TRAINING_REVIEW",
        engine: isTemporal ? "TEMPORAL" : "LOCAL_RUNNER",
        status: "QUEUED",
        ...(isTemporal
          ? {
              enginePhase: "DISPATCH_PENDING",
              nextWakeAt: requestedAt,
            }
          : {}),
        dedupeKey,
        queueName: dispatchTarget.queueName,
        externalWorkflowId: dispatchTarget.externalWorkflowId,
        scheduledAt: requestedAt,
        input: workflowInput,
        ...(isTemporal
          ? {
              commandOutbox: {
                create: {
                  commandType: "START",
                  payload: {
                    source: "creator_training_review_enqueue",
                    scheduledAt: requestedAt.toISOString(),
                  },
                },
              },
            }
          : {}),
      },
      select: creatorTrainingWorkflowSelect,
    });

    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: "WORKFLOW_ENQUEUED",
        payload: {
          workflowRunId: workflow.id,
          workflowKind: "creator_training_review",
          representativeSlug: representative.slug,
          configuredEngine: dispatchTarget.configuredEngine,
          effectiveEngine: dispatchTarget.effectiveEngine,
          queueName: dispatchTarget.queueName,
          externalWorkflowId: dispatchTarget.externalWorkflowId,
          temporalReady: dispatchTarget.temporalReady,
          fallbackReason: dispatchTarget.fallbackReason,
          scheduledAt: requestedAt.toISOString(),
        },
      },
    });

    return serializeCreatorTrainingReviewWorkflow(workflow);
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

const creatorTrainingWorkflowSelect = {
  id: true,
  kind: true,
  engine: true,
  status: true,
  dedupeKey: true,
  queueName: true,
  externalWorkflowId: true,
  scheduledAt: true,
  nextWakeAt: true,
  createdAt: true,
} as const;

type CreatorTrainingWorkflowSelect = typeof creatorTrainingWorkflowSelect;

type DemoCreatorTrainingState = {
  sources: CreatorTrainingSourceSnapshot[];
  feedbackSignals: CreatorFeedbackSignalSnapshot[];
  suggestions: CreatorTrainingSuggestionSnapshot[];
  versions: CreatorTrainingVersionSnapshot[];
  workflow: CreatorTrainingReviewWorkflowSnapshot | null;
};

const globalForCreatorTraining = globalThis as unknown as {
  delegateCreatorTrainingDemoState?: DemoCreatorTrainingState;
};

const DEMO_TRAINING_STATE_PATH =
  process.env.DELEGATE_DEMO_TRAINING_STATE_PATH?.trim() ||
  "/tmp/delegate-creator-training-demo-state.json";

let demoTrainingState: DemoCreatorTrainingState | null =
  globalForCreatorTraining.delegateCreatorTrainingDemoState ?? readDemoTrainingStateFromDisk();

function getDemoTrainingState(): DemoCreatorTrainingState {
  if (!demoTrainingState) {
    const now = new Date().toISOString();
    demoTrainingState = {
      sources: [
        {
          id: "demo-training-source-1",
          representativeId: demoRepresentative.slug,
          kind: "text",
          status: "active",
          title: "Demo public FAQ",
          locator: null,
          contentText: "Refunds are available within seven days. Avoid promising guaranteed revenue.",
          metadata: { source: "demo_fallback" },
          lastSyncedAt: now,
          errorReason: null,
          createdBy: "demo",
          createdAt: now,
          updatedAt: now,
        },
      ],
      feedbackSignals: [
        {
          id: "demo-feedback-1",
          representativeId: demoRepresentative.slug,
          contactId: null,
          conversationId: null,
          turnId: null,
          signalType: "suggested_answer",
          status: "new",
          publicSafe: true,
          note: "Refund FAQ",
          suggestedText: "Refunds are available within seven days after purchase.",
          createdBy: "demo",
          createdAt: now,
          updatedAt: now,
        },
      ],
      suggestions: [
        {
          id: "demo-suggestion-1",
          representativeId: demoRepresentative.slug,
          originKey: "feedback:demo-feedback-1:faq_update",
          originRevision: 1,
          sourceId: null,
          feedbackSignalId: "demo-feedback-1",
          suggestionType: "faq_update",
          status: "pending",
          title: "Add refund FAQ",
          rationale: "Demo fallback suggestion generated from public-safe creator feedback.",
          draftPayload: {
            kind: "faq",
            title: "Refund FAQ",
            summary: "Refunds are available within seven days after purchase.",
          },
          dedupeKey: "demo:refund-faq",
          riskLevel: "medium",
          reviewedAt: null,
          reviewedBy: null,
          reviewNote: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      versions: [],
      workflow: null,
    };
    globalForCreatorTraining.delegateCreatorTrainingDemoState = demoTrainingState;
    persistDemoTrainingState();
  }

  return demoTrainingState;
}

export function getDemoCreatorTrainingKnowledgeOverlay(
  representativeSlug: string,
): KnowledgePackSnapshot | null {
  if (representativeSlug !== demoRepresentative.slug) {
    return null;
  }

  const state = getDemoTrainingState();
  const latestPublished = state.versions.find((version) => version.status === "published");
  return latestPublished ? normalizeKnowledgePackSnapshot(latestPublished.snapshotAfter) : null;
}

function readDemoTrainingStateFromDisk(): DemoCreatorTrainingState | null {
  try {
    if (!existsSync(/* turbopackIgnore: true */ DEMO_TRAINING_STATE_PATH)) {
      return null;
    }
    const parsed = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ DEMO_TRAINING_STATE_PATH, "utf8"),
    ) as DemoCreatorTrainingState;
    if (
      !parsed
      || !Array.isArray(parsed.sources)
      || !Array.isArray(parsed.suggestions)
      || !Array.isArray(parsed.versions)
    ) {
      return null;
    }
    parsed.versions = parsed.versions.map((version, index, versions) => ({
      ...version,
      revisionNumber:
        Number.isInteger(version.revisionNumber) && version.revisionNumber > 0
          ? version.revisionNumber
          : versions.length - index,
      rolledBackBy:
        typeof version.rolledBackBy === "string" && version.rolledBackBy.trim()
          ? version.rolledBackBy.trim()
          : null,
    }));
    parsed.suggestions = normalizeDemoSuggestionOriginRevisions(parsed.suggestions);
    return parsed;
  } catch {
    return null;
  }
}

function persistDemoTrainingState() {
  if (!demoTrainingState) {
    return;
  }
  try {
    writeFileSync(
      /* turbopackIgnore: true */ DEMO_TRAINING_STATE_PATH,
      JSON.stringify(demoTrainingState, null, 2),
    );
  } catch {
    // Best-effort demo fallback only; real persistence belongs to Postgres.
  }
}

function createDemoCreatorTrainingSource(
  representativeSlug: string,
  input: {
    kind: string;
    title: string;
    locator?: string | null | undefined;
    contentText?: string | null | undefined;
    metadata?: unknown;
    createdBy?: string | null | undefined;
  },
): CreatorTrainingSourceSnapshot {
  assertDemoRepresentative(representativeSlug);
  const normalized = normalizeSourceInput(input);
  const now = new Date().toISOString();
  const source: CreatorTrainingSourceSnapshot = {
    id: `demo-training-source-${getDemoTrainingState().sources.length + 1}`,
    representativeId: demoRepresentative.slug,
    kind: normalized.kind,
    status: "draft",
    title: normalized.title,
    locator: normalized.locator ?? null,
    contentText: normalized.contentText ?? null,
    metadata: normalized.metadata ?? { source: "demo_fallback" },
    lastSyncedAt: null,
    errorReason: null,
    createdBy: normalized.createdBy ?? "owner-dashboard",
    createdAt: now,
    updatedAt: now,
  };
  getDemoTrainingState().sources.unshift(source);
  persistDemoTrainingState();
  return cloneTrainingSource(source);
}

function updateDemoCreatorTrainingSource(
  representativeSlug: string,
  sourceId: string,
  input: {
    kind?: string | undefined;
    status?: string | undefined;
    title?: string | undefined;
    locator?: string | null | undefined;
    contentText?: string | null | undefined;
    metadata?: unknown;
    errorReason?: string | null | undefined;
  },
): CreatorTrainingSourceSnapshot {
  assertDemoRepresentative(representativeSlug);
  const source = getDemoTrainingState().sources.find((item) => item.id === sourceId);
  if (!source) {
    throw new Error("Creator training source not found.");
  }

  if (input.kind !== undefined) {
    source.kind = normalizeSourceKind(input.kind);
  }
  if (input.status !== undefined) {
    source.status = normalizeSourceStatus(input.status);
  }
  if (input.title !== undefined) {
    source.title = normalizeRequiredText(input.title, "title");
  }
  if (input.locator !== undefined) {
    source.locator = normalizeNullableText(input.locator);
  }
  if (input.contentText !== undefined) {
    source.contentText = normalizeNullableText(input.contentText);
  }
  if (input.metadata !== undefined) {
    source.metadata = input.metadata;
  }
  if (input.errorReason !== undefined) {
    source.errorReason = normalizeNullableText(input.errorReason);
  }
  source.updatedAt = new Date().toISOString();
  persistDemoTrainingState();

  return cloneTrainingSource(source);
}

function createDemoCreatorFeedbackSignal(
  representativeSlug: string,
  input: {
    signalType: string;
    contactId?: string | null | undefined;
    conversationId?: string | null | undefined;
    turnId?: string | null | undefined;
    publicSafe?: boolean | undefined;
    note?: string | null | undefined;
    suggestedText?: string | null | undefined;
    createdBy?: string | null | undefined;
  },
): CreatorFeedbackSignalSnapshot {
  assertDemoRepresentative(representativeSlug);
  const now = new Date().toISOString();
  const signal: CreatorFeedbackSignalSnapshot = {
    id: `demo-feedback-${getDemoTrainingState().feedbackSignals.length + 1}`,
    representativeId: demoRepresentative.slug,
    contactId: normalizeNullableText(input.contactId),
    conversationId: normalizeNullableText(input.conversationId),
    turnId: normalizeNullableText(input.turnId),
    signalType: normalizeFeedbackSignalType(input.signalType),
    status: "new",
    publicSafe: Boolean(input.publicSafe),
    note: normalizeNullableText(input.note),
    suggestedText: normalizeNullableText(input.suggestedText),
    createdBy: normalizeNullableText(input.createdBy) ?? "owner-dashboard",
    createdAt: now,
    updatedAt: now,
  };
  getDemoTrainingState().feedbackSignals.unshift(signal);
  persistDemoTrainingState();
  return cloneFeedbackSignal(signal);
}

function buildDemoCreatorTrainingSuggestions(
  representativeSlug: string,
): CreatorTrainingSuggestionSnapshot[] {
  assertDemoRepresentative(representativeSlug);
  const state = getDemoTrainingState();
  const now = new Date().toISOString();
  for (const source of state.sources) {
    const sourceRecord = demoSourceSnapshotToRecord(source);
    for (const candidate of buildSourceSuggestionCandidates(sourceRecord)) {
      const originSuggestions = state.suggestions
        .filter((suggestion) => suggestion.originKey === candidate.originKey)
        .sort((left, right) => right.originRevision - left.originRevision);
      const latest = originSuggestions[0] ?? null;
      const latestPublished = originSuggestions.find(
        (suggestion) => suggestion.status === "published",
      ) ?? null;
      const current =
        latest?.dedupeKey === candidate.dedupeKey && latest.status !== "superseded"
          ? latest
          : latestPublished?.dedupeKey === candidate.dedupeKey
            ? latestPublished
            : null;
      for (const suggestion of state.suggestions) {
        if (
          suggestion.originKey === candidate.originKey
          && suggestion.status === "pending"
          && suggestion.id !== current?.id
        ) {
          suggestion.status = "superseded";
          suggestion.updatedAt = now;
        }
      }
      if (current) {
        continue;
      }
      state.suggestions.unshift({
        id: `demo-suggestion-${state.suggestions.length + 1}`,
        representativeId: demoRepresentative.slug,
        originKey: candidate.originKey,
        originRevision: (latest?.originRevision ?? 0) + 1,
        sourceId: candidate.sourceId ?? null,
        feedbackSignalId: candidate.feedbackSignalId ?? null,
        suggestionType: candidate.suggestionType,
        status: "pending",
        title: candidate.title,
        rationale: candidate.rationale,
        draftPayload: candidate.draftPayload,
        dedupeKey: candidate.dedupeKey,
        riskLevel: candidate.riskLevel,
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  persistDemoTrainingState();
  return state.suggestions.map(cloneTrainingSuggestion);
}

function reviewDemoCreatorTrainingSuggestion(
  representativeSlug: string,
  suggestionId: string,
  input: {
    action: CreatorTrainingReviewAction;
    reviewedBy?: string | null | undefined;
    reviewNote?: string | null | undefined;
    editedDraftPayload?: unknown;
    now?: Date | undefined;
  },
): {
  suggestion: CreatorTrainingSuggestionSnapshot;
  version: CreatorTrainingVersionSnapshot | null;
} {
  assertDemoRepresentative(representativeSlug);
  const state = getDemoTrainingState();
  const suggestion = state.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) {
    throw new Error("Creator training suggestion not found.");
  }
  if (suggestion.status !== "pending") {
    throw new Error("Creator training suggestion is no longer pending.");
  }

  const now = (input.now ?? new Date()).toISOString();
  const action = normalizeReviewAction(input.action);

  if (action === "reject" || action === "private") {
    suggestion.reviewedAt = now;
    suggestion.reviewedBy = normalizeNullableText(input.reviewedBy);
    suggestion.reviewNote = normalizeNullableText(input.reviewNote);
    suggestion.updatedAt = now;
    suggestion.status = action === "reject" ? "rejected" : "private";
    persistDemoTrainingState();
    return {
      suggestion: cloneTrainingSuggestion(suggestion),
      version: null,
    };
  }

  const draftPayload =
    input.editedDraftPayload === undefined ? suggestion.draftPayload : input.editedDraftPayload;
  assertKnowledgeGapHasCreatorAnswer(suggestion.suggestionType, draftPayload);
  const evaluationReport = evaluateCreatorTrainingDraftPayload(draftPayload);
  if (!isEvaluationReportPassing(evaluationReport)) {
    throw new Error("Creator training evaluation failed.");
  }

  suggestion.reviewedAt = now;
  suggestion.reviewedBy = normalizeNullableText(input.reviewedBy);
  suggestion.reviewNote = normalizeNullableText(input.reviewNote);
  suggestion.updatedAt = now;
  if (input.editedDraftPayload !== undefined) {
    suggestion.draftPayload = draftPayload;
  }
  suggestion.status = "published";
  const source = suggestion.sourceId
    ? state.sources.find((item) => item.id === suggestion.sourceId)
    : null;
  if (source) {
    source.status = "active";
    source.updatedAt = now;
  }
  const before = loadDemoKnowledgePackSnapshot(state);
  const after = applySuggestionToKnowledgePack(
    before,
    {
      ...suggestion,
      suggestionType: mapSuggestionTypeToDb(suggestion.suggestionType),
    },
    state.suggestions
      .filter((item) => item.originKey === suggestion.originKey)
      .map((item) => ({
        id: item.id,
        draftPayload: item.draftPayload,
      })),
  );
  const version: CreatorTrainingVersionSnapshot = {
    id: `demo-version-${state.versions.length + 1}`,
    representativeId: demoRepresentative.slug,
    revisionNumber:
      Math.max(
        0,
        ...state.versions.map((item) =>
          Number.isInteger(item.revisionNumber) ? item.revisionNumber : 0
        ),
      ) + 1,
    suggestionId: suggestion.id,
    status: "published",
    title: suggestion.title,
    snapshotBefore: before,
    snapshotAfter: after,
    evaluationReport,
    publishedBy: normalizeNullableText(input.reviewedBy),
    publishedAt: now,
    rolledBackBy: null,
    rolledBackAt: null,
    createdAt: now,
  };
  state.versions.unshift(version);
  persistDemoTrainingState();

  return {
    suggestion: cloneTrainingSuggestion(suggestion),
    version: cloneTrainingVersion(version),
  };
}

function loadDemoKnowledgePackSnapshot(state: DemoCreatorTrainingState): KnowledgePackSnapshot {
  const latestPublished = state.versions.find((version) => version.status === "published");
  if (latestPublished) {
    return normalizeKnowledgePackSnapshot(latestPublished.snapshotAfter);
  }

  return {
    identitySummary: demoRepresentative.tagline,
    faq: [],
    materials: [],
    policies: [],
  };
}

function rollbackDemoCreatorTrainingVersion(
  representativeSlug: string,
  versionId: string,
  input: {
    now?: Date | undefined;
    rolledBackBy?: string | null | undefined;
  },
): CreatorTrainingVersionSnapshot {
  assertDemoRepresentative(representativeSlug);
  const state = getDemoTrainingState();
  const version = state.versions.find((item) => item.id === versionId);
  if (!version) {
    throw new Error("Creator training version not found.");
  }
  if (version.status === "rolled_back") {
    return cloneTrainingVersion(version);
  }
  const latestPublished = state.versions.find((item) => item.status === "published");
  if (!latestPublished || latestPublished.id !== version.id) {
    throw new Error("Only the latest applied creator training version can be rolled back.");
  }
  version.status = "rolled_back";
  if (input.rolledBackBy !== undefined) {
    version.rolledBackBy = normalizeNullableText(input.rolledBackBy);
  }
  version.rolledBackAt = (input.now ?? new Date()).toISOString();
  persistDemoTrainingState();
  return cloneTrainingVersion(version);
}

function enqueueDemoCreatorTrainingReviewWorkflow(
  representativeSlug: string,
  input: {
    now?: Date | undefined;
  },
): CreatorTrainingReviewWorkflowSnapshot {
  assertDemoRepresentative(representativeSlug);
  const state = getDemoTrainingState();
  const now = input.now ?? new Date();
  const workflow: CreatorTrainingReviewWorkflowSnapshot = {
    id: "demo-training-workflow-1",
    workflowKind: "creator_training_review",
    engine: "local_runner",
    status: "completed",
    dedupeKey: creatorTrainingReviewDedupeKey(demoRepresentative.slug, now),
    queueName: "local:demo-training",
    externalWorkflowId: null,
    scheduledAt: now.toISOString(),
    nextWakeAt: null,
    createdAt: now.toISOString(),
  };
  state.workflow = workflow;
  buildDemoCreatorTrainingSuggestions(representativeSlug);
  persistDemoTrainingState();
  return { ...workflow };
}

function assertDemoRepresentative(representativeSlug: string) {
  if (representativeSlug !== demoRepresentative.slug) {
    throw new Error("Representative not found.");
  }
}

function cloneTrainingSource(source: CreatorTrainingSourceSnapshot): CreatorTrainingSourceSnapshot {
  return {
    ...source,
    metadata: cloneJsonLike(source.metadata),
  };
}

function demoSourceSnapshotToRecord(source: CreatorTrainingSourceSnapshot): CreatorTrainingSourceRecord {
  return {
    id: source.id,
    representativeId: source.representativeId,
    kind: mapSourceKindToDb(source.kind),
    status: mapSourceStatusToDb(source.status),
    title: source.title,
    locator: source.locator,
    contentText: source.contentText,
    metadata: source.metadata,
    lastSyncedAt: source.lastSyncedAt ? new Date(source.lastSyncedAt) : null,
    errorReason: source.errorReason,
    createdBy: source.createdBy,
    createdAt: new Date(source.createdAt),
    updatedAt: new Date(source.updatedAt),
  };
}

function cloneFeedbackSignal(signal: CreatorFeedbackSignalSnapshot): CreatorFeedbackSignalSnapshot {
  return { ...signal };
}

function cloneTrainingSuggestion(
  suggestion: CreatorTrainingSuggestionSnapshot,
): CreatorTrainingSuggestionSnapshot {
  return {
    ...suggestion,
    draftPayload: cloneJsonLike(suggestion.draftPayload),
  };
}

function cloneTrainingVersion(version: CreatorTrainingVersionSnapshot): CreatorTrainingVersionSnapshot {
  return {
    ...version,
    snapshotBefore: cloneJsonLike(version.snapshotBefore),
    snapshotAfter: cloneJsonLike(version.snapshotAfter),
    evaluationReport: cloneJsonLike(version.evaluationReport),
  };
}

function cloneJsonLike(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

type SuggestionCandidate = {
  originKey: string;
  sourceId?: string | null;
  feedbackSignalId?: string | null;
  suggestionType: CreatorTrainingSuggestionType;
  title: string;
  rationale: string;
  draftPayload: unknown;
  dedupeKey: string;
  riskLevel: string;
};

function buildSourceSuggestionCandidates(
  source: CreatorTrainingSourceRecord,
): SuggestionCandidate[] {
  const title = source.title.trim();
  const contentText = normalizeUploadedSourceText(source.contentText);
  const locator = source.locator?.trim();
  const summary = truncateTrainingText(contentText || locator || "");
  if (!title || !summary) {
    return [];
  }

  const sourceKind = mapSourceKindFromDb(source.kind);
  const documentKind =
    sourceKind === "website" || sourceKind === "url" || sourceKind === "notion"
      ? "deck"
      : "download";
  const draftPayload = {
    kind: documentKind,
    title,
    summary,
    sourceTrainingSourceId: source.id,
    sourceKind,
    ...(locator ? { url: locator } : {}),
  };

  return [
    {
      originKey: `source:${source.id}:material_update`,
      sourceId: source.id,
      suggestionType: "material_update",
      title: `Publish source: ${title}`,
      rationale: "Creator added a public training source that can improve future answers after review.",
      draftPayload,
      dedupeKey:
        `source:${source.id}:material_update:${fingerprintSuggestionEvidence(draftPayload)}`,
      riskLevel: sourceKind === "pdf" || sourceKind === "drive" ? "medium" : "low",
    },
  ];
}

function normalizeUploadedSourceText(value: string | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const inlineStripped = stripInlineUploadPreamble(lines.join(" "));
  if (inlineStripped) {
    return inlineStripped;
  }
  const extractedTextIndex = lines.findIndex((line) => line.toLowerCase() === "extracted text:");
  const contentLines = extractedTextIndex >= 0 ? lines.slice(extractedTextIndex + 1) : lines;

  return contentLines
    .filter((line) => !/^uploaded file:/i.test(line))
    .filter((line) => !/^mime type:/i.test(line))
    .filter((line) => !/^extraction note:/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripInlineUploadPreamble(value: string): string {
  const stripped = value
    .replace(/^uploaded file:\s+\S+(?:\s+mime type:\s+\S+)?\s*/i, "")
    .replace(/\bextracted text:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === value.trim() ? "" : stripped;
}

function buildFeedbackSuggestionCandidates(
  signal: CreatorFeedbackSignalRecord,
): SuggestionCandidate[] {
  if (!signal.publicSafe) {
    return [];
  }

  if (signal.signalType === "CORRECTION" || signal.signalType === "SUGGESTED_ANSWER") {
    if (!signal.suggestedText?.trim()) {
      return [];
    }
    const draftPayload = {
      kind: "faq",
      title: signal.note?.trim() || "Creator corrected answer",
      summary: truncateTrainingText(signal.suggestedText),
      sourceFeedbackSignalId: signal.id,
    };
    return [
      {
        originKey: `feedback:${signal.id}:faq_update`,
        feedbackSignalId: signal.id,
        suggestionType: "faq_update",
        title: "Add corrected public answer",
        rationale: "Creator supplied a public-safe correction that can improve future answers.",
        draftPayload,
        dedupeKey:
          `feedback:${signal.id}:faq_update:${fingerprintSuggestionEvidence(draftPayload)}`,
        riskLevel: "medium",
      },
    ];
  }

  if (signal.signalType === "DO_NOT_SAY") {
    const text = signal.note?.trim() || signal.suggestedText?.trim();
    if (!text) {
      return [];
    }
    const draftPayload = {
      rule: truncateTrainingText(text),
      sourceFeedbackSignalId: signal.id,
    };
    return [
      {
        originKey: `feedback:${signal.id}:tone_rule`,
        feedbackSignalId: signal.id,
        suggestionType: "tone_rule",
        title: "Add creator do-not-say rule",
        rationale: "Creator marked wording that the Delegate should avoid.",
        draftPayload,
        dedupeKey:
          `feedback:${signal.id}:tone_rule:${fingerprintSuggestionEvidence(draftPayload)}`,
        riskLevel: "high",
      },
    ];
  }

  return [];
}

function buildUnknownQuestionCandidates(turns: UnknownQuestionTurnRecord[]): SuggestionCandidate[] {
  const buckets = new Map<
    string,
    {
      text: string;
      count: number;
      latestAt: Date;
      evidence: string[];
    }
  >();
  for (const turn of turns) {
    const text = truncateTrainingText(turn.messageText);
    const key = normalizeSuggestionDedupeText(text);
    if (!key) {
      continue;
    }
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        text,
        count: 1,
        latestAt: turn.createdAt,
        evidence: [
          `${turn.conversationId}:${turn.createdAt.toISOString()}:${key}`,
        ],
      });
      continue;
    }
    existing.count += 1;
    existing.evidence.push(
      `${turn.conversationId}:${turn.createdAt.toISOString()}:${key}`,
    );
    if (turn.createdAt > existing.latestAt) {
      existing.latestAt = turn.createdAt;
      existing.text = text;
    }
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.count >= 2)
    .map(([key, bucket]) => {
      const evidenceFingerprint = fingerprintSuggestionEvidence({
        question: key,
        evidence: [...bucket.evidence].sort(),
      });
      return {
        originKey: `unknown:${key}`,
        suggestionType: "knowledge_gap" as const,
        title: "Fill repeated unanswered question",
        rationale: `This unknown question appeared ${bucket.count} times.`,
        draftPayload: {
          question: bucket.text,
          occurrenceCount: bucket.count,
        },
        dedupeKey: `unknown:${key}:${evidenceFingerprint}`,
        riskLevel: "low",
      };
    });
}

function fingerprintSuggestionEvidence(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(value))
    .digest("hex")
    .slice(0, 16);
}

type KnowledgePackSnapshot = {
  identitySummary: string;
  faq: unknown[];
  materials: unknown[];
  policies: unknown[];
};

async function loadKnowledgePackSnapshot(
  representativeId: string,
  client: Pick<CreatorTrainingReviewClient, "knowledgePack">,
): Promise<KnowledgePackSnapshot> {
  const knowledgePack = await client.knowledgePack.findUnique({
    where: {
      representativeId,
    },
  });
  if (!knowledgePack) {
    return {
      identitySummary: "",
      faq: [],
      materials: [],
      policies: [],
    };
  }

  return {
    identitySummary: knowledgePack.identitySummary,
    faq: normalizeKnowledgeArray(knowledgePack.faq),
    materials: normalizeKnowledgeArray(knowledgePack.materials),
    policies: normalizeKnowledgeArray(knowledgePack.policies),
  };
}

function applySuggestionToKnowledgePack(
  snapshot: KnowledgePackSnapshot,
  suggestion: Pick<
    CreatorTrainingSuggestionRecord,
    "id" | "originKey" | "suggestionType" | "draftPayload"
  >,
  originSuggestions: Array<
    Pick<CreatorTrainingSuggestionRecord, "id" | "draftPayload">
  > = [],
): KnowledgePackSnapshot {
  const documentId = stableTrainingKnowledgeDocumentId(suggestion.originKey);
  const replacedDocumentIds = collectLegacyTrainingKnowledgeDocumentIds([
    ...originSuggestions,
    suggestion,
  ]);
  replacedDocumentIds.add(documentId);
  const next: KnowledgePackSnapshot = {
    identitySummary: snapshot.identitySummary,
    faq: withoutKnowledgeDocuments(snapshot.faq, replacedDocumentIds),
    materials: withoutKnowledgeDocuments(snapshot.materials, replacedDocumentIds),
    policies: withoutKnowledgeDocuments(snapshot.policies, replacedDocumentIds),
  };
  const type = mapSuggestionTypeFromDb(suggestion.suggestionType);

  if (type === "faq_update" || type === "knowledge_gap") {
    next.faq.push(normalizeTrainingKnowledgeDocument(suggestion, "faq", documentId));
    return next;
  }
  if (type === "material_update") {
    next.materials.push(normalizeTrainingKnowledgeDocument(suggestion, "download", documentId));
    return next;
  }
  if (type === "policy_update" || type === "tone_rule") {
    next.policies.push(normalizeTrainingKnowledgeDocument(suggestion, "policy", documentId));
    return next;
  }

  return next;
}

function normalizeTrainingKnowledgeDocument(
  suggestion: Pick<CreatorTrainingSuggestionRecord, "id" | "draftPayload">,
  fallbackKind: string,
  documentId: string,
) {
  const payload = isRecord(suggestion.draftPayload) ? suggestion.draftPayload : {};
  const title =
    typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim()
      : typeof payload.question === "string" && payload.question.trim()
        ? payload.question.trim()
        : "Creator training update";
  const summary =
    typeof payload.summary === "string" && payload.summary.trim()
      ? normalizeUploadedSourceText(payload.summary)
      : typeof payload.answer === "string" && payload.answer.trim()
        ? normalizeUploadedSourceText(payload.answer)
        : typeof payload.rule === "string" && payload.rule.trim()
          ? normalizeUploadedSourceText(payload.rule)
          : typeof payload.question === "string" && payload.question.trim()
            ? `Needs a creator-approved answer for: ${normalizeUploadedSourceText(payload.question)}`
            : "Creator-approved training update.";
  const kind =
    typeof payload.kind === "string" && payload.kind.trim() ? payload.kind.trim() : fallbackKind;

  return {
    id: documentId,
    title,
    kind,
    summary,
    ...(typeof payload.url === "string" && payload.url.trim() ? { url: payload.url.trim() } : {}),
  };
}

function stableTrainingKnowledgeDocumentId(originKey: string): string {
  return `training_origin_${createHash("sha256").update(originKey).digest("hex")}`;
}

function collectLegacyTrainingKnowledgeDocumentIds(
  suggestions: Array<Pick<CreatorTrainingSuggestionRecord, "id" | "draftPayload">>,
): Set<string> {
  const ids = new Set<string>();
  for (const suggestion of suggestions) {
    ids.add(`training_${suggestion.id}`);
    const payload = isRecord(suggestion.draftPayload) ? suggestion.draftPayload : {};
    if (typeof payload.id === "string" && payload.id.trim()) {
      ids.add(payload.id.trim());
    }
  }
  return ids;
}

function withoutKnowledgeDocuments(
  documents: unknown[],
  replacedDocumentIds: ReadonlySet<string>,
): unknown[] {
  return documents.filter((document) => {
    if (!isRecord(document) || typeof document.id !== "string") {
      return true;
    }
    return !replacedDocumentIds.has(document.id);
  });
}

function assertKnowledgeGapHasCreatorAnswer(
  suggestionType: string,
  draftPayload: unknown,
) {
  if (mapSuggestionTypeFromDb(suggestionType) !== "knowledge_gap") return;

  const payload = isRecord(draftPayload) ? draftPayload : {};
  const answer =
    typeof payload.summary === "string"
      ? normalizeUploadedSourceText(payload.summary)
      : typeof payload.answer === "string"
        ? normalizeUploadedSourceText(payload.answer)
        : "";
  const normalized = answer.toLowerCase().replace(/\s+/g, " ").trim();
  const isPlaceholder =
    normalized.startsWith("needs a creator-approved answer")
    || normalized === "creator-approved training update."
    || normalized === "creator-approved training update"
    || normalized === "awaiting owner review."
    || normalized === "awaiting owner review"
    || normalized.includes("等待 owner 审核")
    || normalized.includes("待 owner 填写")
    || normalized.includes("请 owner 填写");

  if (answer.length < 2 || isPlaceholder) {
    throw new Error("Knowledge gap requires a creator-authored answer.");
  }
}

async function resolveFeedbackScope(
  representativeId: string,
  input: {
    contactId?: string | null | undefined;
    conversationId?: string | null | undefined;
    turnId?: string | null | undefined;
  },
  client: CreatorFeedbackSignalClient,
) {
  const turnId = normalizeNullableText(input.turnId);
  const explicitConversationId = normalizeNullableText(input.conversationId);
  const explicitContactId = normalizeNullableText(input.contactId);

  let conversationId = explicitConversationId;
  if (turnId) {
    const turn = await client.conversationTurn.findFirst({
      where: {
        id: turnId,
        conversation: {
          representativeId,
        },
      },
      select: {
        id: true,
        conversationId: true,
      },
    });
    if (!turn) {
      throw new Error("Conversation turn not found for representative.");
    }
    conversationId = conversationId ?? turn.conversationId;
  }

  let contactId = explicitContactId;
  if (conversationId) {
    const conversation = await client.conversation.findFirst({
      where: {
        id: conversationId,
        representativeId,
      },
      select: {
        id: true,
        contactId: true,
      },
    });
    if (!conversation) {
      throw new Error("Conversation not found for representative.");
    }
    contactId = contactId ?? conversation.contactId;
  }

  if (contactId) {
    const contact = await client.contact.findFirst({
      where: {
        id: contactId,
        representativeId,
      },
      select: {
        id: true,
      },
    });
    if (!contact) {
      throw new Error("Contact not found for representative.");
    }
  }

  return {
    contactId,
    conversationId,
    turnId,
  };
}

async function requireRepresentative(
  representativeSlug: string,
  client: RepresentativeLookupClient,
) {
  const slug = normalizeRequiredText(representativeSlug, "representativeSlug");
  const representative = await client.representative.findUnique({
    where: { slug },
    select: { id: true, slug: true },
  });
  if (!representative) {
    throw new Error("Representative not found.");
  }
  return representative;
}

async function requireSource(
  representativeSlug: string,
  sourceId: string,
  client: CreatorTrainingSourceClient,
) {
  const representative = await requireRepresentative(representativeSlug, client);
  const id = normalizeRequiredText(sourceId, "sourceId");
  const source = await client.creatorTrainingSource.findFirst({
    where: {
      id,
      representativeId: representative.id,
    },
  });
  if (!source) {
    throw new Error("Creator training source not found.");
  }
  return source;
}

function normalizeSourceInput(input: {
  kind: string;
  title: string;
  locator?: string | null | undefined;
  contentText?: string | null | undefined;
  metadata?: unknown;
  createdBy?: string | null | undefined;
}) {
  return {
    kind: normalizeSourceKind(input.kind),
    title: normalizeRequiredText(input.title, "title"),
    ...(input.locator !== undefined ? { locator: normalizeNullableText(input.locator) } : {}),
    ...(input.contentText !== undefined
      ? { contentText: normalizeNullableText(input.contentText) }
      : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.createdBy !== undefined ? { createdBy: normalizeNullableText(input.createdBy) } : {}),
  };
}

function normalizeSourceKind(value: string): CreatorTrainingSourceKind {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "url" ||
    normalized === "pdf" ||
    normalized === "text" ||
    normalized === "notion" ||
    normalized === "drive" ||
    normalized === "website"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported creator training source kind: ${value}`);
}

function normalizeSourceStatus(value: string): CreatorTrainingSourceStatus {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "draft" ||
    normalized === "active" ||
    normalized === "disabled" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported creator training source status: ${value}`);
}

function normalizeFeedbackSignalType(value: string): CreatorFeedbackSignalType {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "approve" ||
    normalized === "correction" ||
    normalized === "do_not_say" ||
    normalized === "suggested_answer"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported creator feedback signal type: ${value}`);
}

function mapSourceKindToDb(value: CreatorTrainingSourceKind): Uppercase<CreatorTrainingSourceKind> {
  return value.toUpperCase() as Uppercase<CreatorTrainingSourceKind>;
}

function mapSourceStatusToDb(value: CreatorTrainingSourceStatus) {
  return value.toUpperCase() as "DRAFT" | "ACTIVE" | "DISABLED" | "FAILED";
}

function mapSourceKindFromDb(value: string): CreatorTrainingSourceKind {
  return value.toLowerCase() as CreatorTrainingSourceKind;
}

function mapSourceStatusFromDb(value: string): CreatorTrainingSourceStatus {
  return value.toLowerCase() as CreatorTrainingSourceStatus;
}

function mapFeedbackSignalTypeToDb(value: CreatorFeedbackSignalType) {
  return value.toUpperCase() as "APPROVE" | "CORRECTION" | "DO_NOT_SAY" | "SUGGESTED_ANSWER";
}

function mapFeedbackSignalTypeFromDb(value: string): CreatorFeedbackSignalType {
  return value.toLowerCase() as CreatorFeedbackSignalType;
}

function mapSuggestionTypeToDb(value: CreatorTrainingSuggestionType) {
  return value.toUpperCase() as
    | "FAQ_UPDATE"
    | "POLICY_UPDATE"
    | "MATERIAL_UPDATE"
    | "TONE_RULE"
    | "SKILL_RECOMMENDATION"
    | "KNOWLEDGE_GAP";
}

function mapSuggestionTypeFromDb(value: string): CreatorTrainingSuggestionType {
  return value.toLowerCase() as CreatorTrainingSuggestionType;
}

function mapSuggestionStatusToDb(value: CreatorTrainingSuggestionStatus) {
  return value.toUpperCase() as
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "PRIVATE"
    | "PUBLISHED"
    | "SUPERSEDED";
}

function mapSuggestionStatusFromDb(value: string): CreatorTrainingSuggestionStatus {
  return value.toLowerCase() as CreatorTrainingSuggestionStatus;
}

function mapVersionStatusFromDb(value: string): "published" | "rolled_back" {
  return value.toLowerCase() as "published" | "rolled_back";
}

function serializeCreatorTrainingSource(
  source: CreatorTrainingSourceRecord,
): CreatorTrainingSourceSnapshot {
  return {
    id: source.id,
    representativeId: source.representativeId,
    kind: mapSourceKindFromDb(source.kind),
    status: mapSourceStatusFromDb(source.status),
    title: source.title,
    locator: source.locator,
    contentText: source.contentText,
    metadata: source.metadata,
    lastSyncedAt: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null,
    errorReason: source.errorReason,
    createdBy: source.createdBy,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function serializeCreatorFeedbackSignal(
  signal: CreatorFeedbackSignalRecord,
): CreatorFeedbackSignalSnapshot {
  return {
    id: signal.id,
    representativeId: signal.representativeId,
    contactId: signal.contactId,
    conversationId: signal.conversationId,
    turnId: signal.turnId,
    signalType: mapFeedbackSignalTypeFromDb(signal.signalType),
    status: signal.status,
    publicSafe: signal.publicSafe,
    note: signal.note,
    suggestedText: signal.suggestedText,
    createdBy: signal.createdBy,
    createdAt: signal.createdAt.toISOString(),
    updatedAt: signal.updatedAt.toISOString(),
  };
}

function serializeCreatorTrainingSuggestion(
  suggestion: CreatorTrainingSuggestionRecord,
): CreatorTrainingSuggestionSnapshot {
  return {
    id: suggestion.id,
    representativeId: suggestion.representativeId,
    originKey: suggestion.originKey,
    originRevision: suggestion.originRevision,
    sourceId: suggestion.sourceId,
    feedbackSignalId: suggestion.feedbackSignalId,
    suggestionType: mapSuggestionTypeFromDb(suggestion.suggestionType),
    status: mapSuggestionStatusFromDb(suggestion.status),
    title: suggestion.title,
    rationale: suggestion.rationale,
    draftPayload: suggestion.draftPayload,
    dedupeKey: suggestion.dedupeKey,
    riskLevel: suggestion.riskLevel,
    reviewedAt: suggestion.reviewedAt ? suggestion.reviewedAt.toISOString() : null,
    reviewedBy: suggestion.reviewedBy,
    reviewNote: suggestion.reviewNote,
    createdAt: suggestion.createdAt.toISOString(),
    updatedAt: suggestion.updatedAt.toISOString(),
  };
}

function normalizeStoredSuggestionOriginKey(
  suggestion: Pick<
    CreatorTrainingSuggestionSnapshot,
    "id" | "sourceId" | "feedbackSignalId" | "suggestionType" | "dedupeKey"
  > & { originKey?: unknown },
): string {
  if (typeof suggestion.originKey === "string" && suggestion.originKey.trim()) {
    return suggestion.originKey.trim();
  }
  if (suggestion.sourceId) {
    return `source:${suggestion.sourceId}:${suggestion.suggestionType}`;
  }
  if (suggestion.feedbackSignalId) {
    return `feedback:${suggestion.feedbackSignalId}:${suggestion.suggestionType}`;
  }
  if (suggestion.dedupeKey.startsWith("unknown:")) {
    return suggestion.dedupeKey.replace(/:[0-9a-f]{16}$/u, "");
  }
  return `legacy:${suggestion.id}`;
}

function normalizeDemoSuggestionOriginRevisions(
  suggestions: CreatorTrainingSuggestionSnapshot[],
): CreatorTrainingSuggestionSnapshot[] {
  const normalized = suggestions.map((suggestion) => ({
    ...suggestion,
    originKey: normalizeStoredSuggestionOriginKey(suggestion),
    originRevision: 0,
  }));
  const nextRevisionByOrigin = new Map<string, number>();
  for (const suggestion of [...normalized].sort((left, right) => {
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    return createdAtOrder || left.id.localeCompare(right.id);
  })) {
    const originRevision = (nextRevisionByOrigin.get(suggestion.originKey) ?? 0) + 1;
    suggestion.originRevision = originRevision;
    nextRevisionByOrigin.set(suggestion.originKey, originRevision);
  }
  return normalized;
}

function serializeCreatorTrainingVersion(
  version: CreatorTrainingVersionRecord,
): CreatorTrainingVersionSnapshot {
  return {
    id: version.id,
    representativeId: version.representativeId,
    revisionNumber: version.revisionNumber,
    suggestionId: version.suggestionId,
    status: mapVersionStatusFromDb(version.status),
    title: version.title,
    snapshotBefore: version.snapshotBefore,
    snapshotAfter: version.snapshotAfter,
    evaluationReport: version.evaluationReport,
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt.toISOString(),
    rolledBackBy: version.rolledBackBy,
    rolledBackAt: version.rolledBackAt ? version.rolledBackAt.toISOString() : null,
    createdAt: version.createdAt.toISOString(),
  };
}

function serializeCreatorTrainingReviewWorkflow(
  workflow: CreatorTrainingWorkflowRecord,
): CreatorTrainingReviewWorkflowSnapshot {
  return {
    id: workflow.id,
    workflowKind: "creator_training_review",
    engine: workflow.engine === "TEMPORAL" ? "temporal" : "local_runner",
    status: workflow.status.toLowerCase() as CreatorTrainingReviewWorkflowSnapshot["status"],
    dedupeKey: workflow.dedupeKey,
    queueName: workflow.queueName,
    externalWorkflowId: workflow.externalWorkflowId,
    scheduledAt: workflow.scheduledAt.toISOString(),
    nextWakeAt: workflow.nextWakeAt ? workflow.nextWakeAt.toISOString() : null,
    createdAt: workflow.createdAt.toISOString(),
  };
}

function normalizeRequiredText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeReviewAction(value: string): CreatorTrainingReviewAction {
  if (value === "approve" || value === "reject" || value === "private") {
    return value;
  }
  throw new Error(`Unsupported creator training review action: ${value}`);
}

function normalizeKnowledgeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => (isRecord(item) ? { ...item } : item)) : [];
}

function normalizeKnowledgePackSnapshot(value: unknown): KnowledgePackSnapshot {
  if (!isRecord(value)) {
    return {
      identitySummary: "",
      faq: [],
      materials: [],
      policies: [],
    };
  }

  return {
    identitySummary:
      typeof value.identitySummary === "string" ? value.identitySummary : "",
    faq: normalizeKnowledgeArray(value.faq),
    materials: normalizeKnowledgeArray(value.materials),
    policies: normalizeKnowledgeArray(value.policies),
  };
}

function knowledgePackSnapshotsEqual(
  left: KnowledgePackSnapshot,
  right: KnowledgePackSnapshot,
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isEvaluationReportPassing(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.outcome === "failed") {
    return false;
  }
  if (Array.isArray(value.checks)) {
    return !value.checks.some(
      (check) =>
        isRecord(check) &&
        check.severity === "critical" &&
        check.passed === false,
    );
  }
  return value.outcome === "passed";
}

function collectSearchableText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSearchableText(item));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectSearchableText(item));
  }
  return [];
}

function containsGuaranteedOutcomeClaim(value: string): boolean {
  return [
    "guaranteed revenue",
    "guaranteed income",
    "guaranteed earnings",
    "100% guaranteed",
    "保证收益",
    "保证赚钱",
    "稳赚",
    "包赚",
  ].some((pattern) => value.includes(pattern));
}

function isProductionCreatorTrainingClient(
  client: RepresentativeKnowledgePackLockClient,
): boolean {
  return client === (prisma as unknown as RepresentativeKnowledgePackLockClient);
}

function shouldUseStaticFallbackMode(representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && !process.env.DATABASE_URL?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNullableText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeSuggestionDedupeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]/g, "")
    .slice(0, 120);
}

function truncateTrainingText(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 480 ? normalized.slice(0, 480) : normalized;
}
