import {
  creatorTrainingReviewDedupeKey,
  creatorTrainingReviewSubjectId,
  getWorkflowEngineConfig,
  resolveWorkflowDispatchTarget,
  shouldDispatchWorkflowViaTemporalOutbox,
} from "@delegate/workflows";

import { prisma } from "./prisma";

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
  | "published";
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
  suggestionId: string | null;
  status: "published" | "rolled_back";
  title: string;
  snapshotBefore: unknown;
  snapshotAfter: unknown;
  evaluationReport: unknown;
  publishedBy: string | null;
  publishedAt: string;
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

type CreatorTrainingSuggestionClient = RepresentativeLookupClient & {
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
  creatorTrainingSuggestion: {
    upsert(args: {
      where: {
        representativeId_dedupeKey: {
          representativeId: string;
          dedupeKey: string;
        };
      };
      update: {
        suggestionType: "FAQ_UPDATE" | "POLICY_UPDATE" | "MATERIAL_UPDATE" | "TONE_RULE" | "SKILL_RECOMMENDATION" | "KNOWLEDGE_GAP";
        title: string;
        rationale: string;
        draftPayload: unknown;
        riskLevel: string;
        sourceId?: string | null;
        feedbackSignalId?: string | null;
      };
      create: {
        representativeId: string;
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
        status?: "PENDING" | "APPROVED" | "REJECTED" | "PRIVATE" | "PUBLISHED" | undefined;
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
  suggestionId: string | null;
  status: string;
  title: string;
  snapshotBefore: unknown;
  snapshotAfter: unknown;
  evaluationReport: unknown;
  publishedBy: string | null;
  publishedAt: Date;
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

type CreatorTrainingReviewClient = RepresentativeLookupClient & {
  $transaction?: <T>(callback: (client: CreatorTrainingReviewClient) => Promise<T>) => Promise<T>;
  creatorTrainingSuggestion: {
    findFirst(args: {
      where: { id: string; representativeId: string };
    }): Promise<CreatorTrainingSuggestionRecord | null>;
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
        identitySummary: string;
        faq: unknown;
        materials: unknown;
        policies: unknown;
      };
      create: {
        representativeId: string;
        identitySummary: string;
        faq: unknown;
        materials: unknown;
        policies: unknown;
      };
    }): Promise<KnowledgePackRecord>;
  };
  creatorTrainingVersion: {
    create(args: {
      data: {
        representativeId: string;
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

type CreatorTrainingVersionListClient = RepresentativeLookupClient & {
  creatorTrainingVersion: {
    findMany(args: {
      where: {
        representativeId: string;
      };
      orderBy: Array<{ publishedAt: "desc" } | { createdAt: "desc" }>;
      take: number;
    }): Promise<CreatorTrainingVersionRecord[]>;
  };
};

type CreatorTrainingRollbackClient = RepresentativeLookupClient & {
  $transaction?: <T>(callback: (client: CreatorTrainingRollbackClient) => Promise<T>) => Promise<T>;
  knowledgePack: CreatorTrainingReviewClient["knowledgePack"];
  creatorTrainingVersion: {
    findFirst(args: {
      where: { id: string; representativeId: string };
    }): Promise<CreatorTrainingVersionRecord | null>;
    update(args: {
      where: { id: string };
      data: {
        status: "ROLLED_BACK";
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
  } = {},
  client: CreatorTrainingSuggestionClient = prisma as unknown as CreatorTrainingSuggestionClient,
): Promise<CreatorTrainingSuggestionSnapshot[]> {
  const representative = await requireRepresentative(representativeSlug, client);
  const feedbackSignals = await client.creatorFeedbackSignal.findMany({
    where: {
      representativeId: representative.id,
      status: "new",
    },
    orderBy: [{ createdAt: "desc" }],
    take: input.feedbackLimit ?? 100,
  });
  const unknownTurns = await client.conversationTurn.findMany({
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
    ...feedbackSignals.flatMap((signal) => buildFeedbackSuggestionCandidates(signal)),
    ...buildUnknownQuestionCandidates(unknownTurns),
  ];
  const suggestions: CreatorTrainingSuggestionSnapshot[] = [];

  for (const candidate of candidates) {
    const suggestion = await client.creatorTrainingSuggestion.upsert({
      where: {
        representativeId_dedupeKey: {
          representativeId: representative.id,
          dedupeKey: candidate.dedupeKey,
        },
      },
      update: {
        suggestionType: mapSuggestionTypeToDb(candidate.suggestionType),
        title: candidate.title,
        rationale: candidate.rationale,
        draftPayload: candidate.draftPayload,
        riskLevel: candidate.riskLevel,
        ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
        ...(candidate.feedbackSignalId ? { feedbackSignalId: candidate.feedbackSignalId } : {}),
      },
      create: {
        representativeId: representative.id,
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
}

export async function listCreatorTrainingSuggestions(
  representativeSlug: string,
  input: {
    status?: CreatorTrainingSuggestionStatus | undefined;
    limit?: number | undefined;
  } = {},
  client: CreatorTrainingSuggestionClient = prisma as unknown as CreatorTrainingSuggestionClient,
): Promise<CreatorTrainingSuggestionSnapshot[]> {
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
    evaluationReport?: unknown;
    now?: Date | undefined;
  },
  client: CreatorTrainingReviewClient = prisma as unknown as CreatorTrainingReviewClient,
): Promise<{
  suggestion: CreatorTrainingSuggestionSnapshot;
  version: CreatorTrainingVersionSnapshot | null;
}> {
  const representative = await requireRepresentative(representativeSlug, client);
  const now = input.now ?? new Date();
  const action = normalizeReviewAction(input.action);
  const run = async (tx: CreatorTrainingReviewClient) => {
    const suggestion = await tx.creatorTrainingSuggestion.findFirst({
      where: {
        id: normalizeRequiredText(suggestionId, "suggestionId"),
        representativeId: representative.id,
      },
    });
    if (!suggestion) {
      throw new Error("Creator training suggestion not found.");
    }

    if (action === "reject" || action === "private") {
      const reviewed = await tx.creatorTrainingSuggestion.update({
        where: { id: suggestion.id },
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
      return {
        suggestion: serializeCreatorTrainingSuggestion(reviewed),
        version: null,
      };
    }

    const draftPayload =
      input.editedDraftPayload === undefined ? suggestion.draftPayload : input.editedDraftPayload;
    const before = await loadKnowledgePackSnapshot(representative.id, tx);
    const after = applySuggestionToKnowledgePack(before, {
      ...suggestion,
      draftPayload,
    });
    const evaluationReport =
      input.evaluationReport ?? evaluateCreatorTrainingDraftPayload(draftPayload);
    if (!isEvaluationReportPassing(evaluationReport)) {
      throw new Error("Creator training evaluation failed.");
    }
    await tx.knowledgePack.upsert({
      where: { representativeId: representative.id },
      update: {
        identitySummary: after.identitySummary,
        faq: after.faq,
        materials: after.materials,
        policies: after.policies,
      },
      create: {
        representativeId: representative.id,
        identitySummary: after.identitySummary,
        faq: after.faq,
        materials: after.materials,
        policies: after.policies,
      },
    });
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
    const version = await tx.creatorTrainingVersion.create({
      data: {
        representativeId: representative.id,
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
  const representative = await requireRepresentative(representativeSlug, client);
  const versions = await client.creatorTrainingVersion.findMany({
    where: {
      representativeId: representative.id,
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: input.limit ?? 20,
  });

  return versions.map(serializeCreatorTrainingVersion);
}

export async function rollbackCreatorTrainingVersion(
  representativeSlug: string,
  versionId: string,
  input: {
    now?: Date | undefined;
  } = {},
  client: CreatorTrainingRollbackClient = prisma as unknown as CreatorTrainingRollbackClient,
): Promise<CreatorTrainingVersionSnapshot> {
  const representative = await requireRepresentative(representativeSlug, client);
  const now = input.now ?? new Date();
  const run = async (tx: CreatorTrainingRollbackClient) => {
    const version = await tx.creatorTrainingVersion.findFirst({
      where: {
        id: normalizeRequiredText(versionId, "versionId"),
        representativeId: representative.id,
      },
    });
    if (!version) {
      throw new Error("Creator training version not found.");
    }
    if (mapVersionStatusFromDb(version.status) === "rolled_back") {
      return serializeCreatorTrainingVersion(version);
    }

    const before = normalizeKnowledgePackSnapshot(version.snapshotBefore);
    await tx.knowledgePack.upsert({
      where: { representativeId: representative.id },
      update: {
        identitySummary: before.identitySummary,
        faq: before.faq,
        materials: before.materials,
        policies: before.policies,
      },
      create: {
        representativeId: representative.id,
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

type SuggestionCandidate = {
  sourceId?: string | null;
  feedbackSignalId?: string | null;
  suggestionType: CreatorTrainingSuggestionType;
  title: string;
  rationale: string;
  draftPayload: unknown;
  dedupeKey: string;
  riskLevel: string;
};

function buildFeedbackSuggestionCandidates(
  signal: CreatorFeedbackSignalRecord,
): SuggestionCandidate[] {
  if (signal.signalType === "CORRECTION" || signal.signalType === "SUGGESTED_ANSWER") {
    if (!signal.publicSafe || !signal.suggestedText?.trim()) {
      return [];
    }
    return [
      {
        feedbackSignalId: signal.id,
        suggestionType: "faq_update",
        title: "Add corrected public answer",
        rationale: "Creator supplied a public-safe correction that can improve future answers.",
        draftPayload: {
          kind: "faq",
          title: signal.note?.trim() || "Creator corrected answer",
          summary: truncateTrainingText(signal.suggestedText),
          sourceFeedbackSignalId: signal.id,
        },
        dedupeKey: `feedback:${signal.id}:faq_update`,
        riskLevel: "medium",
      },
    ];
  }

  if (signal.signalType === "DO_NOT_SAY") {
    const text = signal.note?.trim() || signal.suggestedText?.trim();
    if (!text) {
      return [];
    }
    return [
      {
        feedbackSignalId: signal.id,
        suggestionType: "tone_rule",
        title: "Add creator do-not-say rule",
        rationale: "Creator marked wording that the Delegate should avoid.",
        draftPayload: {
          rule: truncateTrainingText(text),
          sourceFeedbackSignalId: signal.id,
        },
        dedupeKey: `feedback:${signal.id}:tone_rule`,
        riskLevel: "high",
      },
    ];
  }

  return [];
}

function buildUnknownQuestionCandidates(turns: UnknownQuestionTurnRecord[]): SuggestionCandidate[] {
  const buckets = new Map<string, { text: string; count: number; latestAt: Date }>();
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
      });
      continue;
    }
    existing.count += 1;
    if (turn.createdAt > existing.latestAt) {
      existing.latestAt = turn.createdAt;
      existing.text = text;
    }
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.count >= 2)
    .map(([key, bucket]) => ({
      suggestionType: "knowledge_gap",
      title: "Fill repeated unanswered question",
      rationale: `This unknown question appeared ${bucket.count} times.`,
      draftPayload: {
        question: bucket.text,
        occurrenceCount: bucket.count,
      },
      dedupeKey: `unknown:${key}`,
      riskLevel: "low",
    }));
}

type KnowledgePackSnapshot = {
  identitySummary: string;
  faq: unknown[];
  materials: unknown[];
  policies: unknown[];
};

async function loadKnowledgePackSnapshot(
  representativeId: string,
  client: CreatorTrainingReviewClient,
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
  suggestion: Pick<CreatorTrainingSuggestionRecord, "id" | "suggestionType" | "draftPayload">,
): KnowledgePackSnapshot {
  const next: KnowledgePackSnapshot = {
    identitySummary: snapshot.identitySummary,
    faq: [...snapshot.faq],
    materials: [...snapshot.materials],
    policies: [...snapshot.policies],
  };
  const type = mapSuggestionTypeFromDb(suggestion.suggestionType);

  if (type === "faq_update" || type === "knowledge_gap") {
    next.faq.push(normalizeTrainingKnowledgeDocument(suggestion, "faq"));
    return next;
  }
  if (type === "material_update") {
    next.materials.push(normalizeTrainingKnowledgeDocument(suggestion, "download"));
    return next;
  }
  if (type === "policy_update" || type === "tone_rule") {
    next.policies.push(normalizeTrainingKnowledgeDocument(suggestion, "policy"));
    return next;
  }

  return next;
}

function normalizeTrainingKnowledgeDocument(
  suggestion: Pick<CreatorTrainingSuggestionRecord, "id" | "draftPayload">,
  fallbackKind: string,
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
      ? payload.summary.trim()
      : typeof payload.rule === "string" && payload.rule.trim()
        ? payload.rule.trim()
        : typeof payload.question === "string" && payload.question.trim()
          ? `Needs a creator-approved answer for: ${payload.question.trim()}`
          : "Creator-approved training update.";
  const kind =
    typeof payload.kind === "string" && payload.kind.trim() ? payload.kind.trim() : fallbackKind;

  return {
    id:
      typeof payload.id === "string" && payload.id.trim()
        ? payload.id.trim()
        : `training_${suggestion.id}`,
    title,
    kind,
    summary,
    ...(typeof payload.url === "string" && payload.url.trim() ? { url: payload.url.trim() } : {}),
  };
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
    | "PUBLISHED";
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

function serializeCreatorTrainingVersion(
  version: CreatorTrainingVersionRecord,
): CreatorTrainingVersionSnapshot {
  return {
    id: version.id,
    representativeId: version.representativeId,
    suggestionId: version.suggestionId,
    status: mapVersionStatusFromDb(version.status),
    title: version.title,
    snapshotBefore: version.snapshotBefore,
    snapshotAfter: version.snapshotAfter,
    evaluationReport: version.evaluationReport,
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt.toISOString(),
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
