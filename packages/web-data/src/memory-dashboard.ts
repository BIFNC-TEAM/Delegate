import { createHash } from "node:crypto";

import {
  EventType,
  GovernedMemoryStatus,
  KnowledgeAssetStatus,
  MemoryCandidateStatus,
  MemoryCategory,
  MemoryCleanupStatus,
  MemoryExtractionStatus,
  MemoryExtractionTrigger,
  MemoryExpiryAction,
  MemoryProjectionLane,
  MemoryProjectionStatus,
  MemoryReconciliationStatus,
  MemoryReviewOutcome,
  MemoryReviewerRole,
  MemoryScope,
  MemorySourceKind,
  MemoryUseSourceKind,
  MemoryUseRunStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
  OrganizationMemberRole,
  Prisma,
  PublicKnowledgeProjectionSourceKind,
  RepresentativeChannelKind,
  type PrismaClient,
} from "@prisma/client";
import {
  OpenVikingClient,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedRepresentativeExperienceVersionUri,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeVersionKnowledgeAssetUri,
  resolveOpenVikingEnv,
} from "@delegate/openviking";
import { z } from "zod";

import {
  approveMemoryCandidate,
  archiveGovernedMemory,
  blockMemoryCandidate,
  rejectMemoryCandidate,
  requestGovernedMemoryDeletion,
  requestMemoryCorrection,
  restoreGovernedMemory,
  retryGovernedMemoryCleanup,
  suppressGovernedMemory,
  type ContactMemoryPreferenceField,
  type MemoryGovernanceCommandMetadata,
  type RepresentativeMemoryPatternCode,
} from "./memory-governance";
import { resolveMemoryExtractionPolicyGate } from "./memory-extraction";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,2048}$/u;
const reasonCodePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const pageSizeDefault = 25;
const pageSizeMaximum = 100;

const identifier = z.string().trim().min(1).max(191).regex(identifierPattern);
const optionalIdentifier = identifier.optional();
const isoDateTime = z.string().trim().datetime({ offset: true });
const optionalIsoDateTime = isoDateTime.optional();
const optionalCursor = z.string().trim().regex(cursorPattern).optional();
const optionalQuery = z.string().trim().max(200).optional();
const optionalLimit = z.coerce.number().int().min(1).max(pageSizeMaximum).optional();

const publicKnowledgeSnapshotSchema = z.object({
  identity: z.object({
    displayName: z.string().trim().min(1),
    roleSummary: z.string(),
    tone: z.string(),
    languages: z.array(z.string()),
  }),
  publicMode: z.boolean(),
  humanInLoop: z.boolean(),
  groupActivation: z.string().trim().min(1),
  conversation: z.object({
    freeReplyLimit: z.number().int().min(0),
    freeScope: z.array(z.string()),
    paywalledIntents: z.array(z.string()),
    handoffWindowHours: z.number().int().min(0),
    handoffPrompt: z.string(),
  }),
  governance: z.object({ allowedSkills: z.array(z.string()) }),
  knowledge: z.object({
    identitySummary: z.string(),
    faq: z.array(z.object({
      title: z.string().trim().min(1),
      summary: z.string(),
      url: z.string().trim().optional(),
    })),
    materials: z.array(z.object({
      title: z.string().trim().min(1),
      summary: z.string(),
      url: z.string().trim().optional(),
    })),
    policies: z.array(z.object({
      title: z.string().trim().min(1),
      summary: z.string(),
      url: z.string().trim().optional(),
    })),
  }).nullable(),
  knowledgeAssets: z.array(z.object({
    assetId: identifier,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
    processingVersion: z.number().int().min(1),
  })).default([]),
  pricing: z.array(z.object({
    tier: z.string(),
    name: z.string(),
    stars: z.number().int().min(0),
    summary: z.string(),
    includedReplies: z.number().int().min(0),
    includesPriorityHandoff: z.boolean(),
  })),
});

const representativeQueryFields = {
  rep: identifier,
} as const;

export const memoryOverviewQuerySchema = z.object({
  ...representativeQueryFields,
}).strict();

export const memoryEntriesQuerySchema = z.object({
  ...representativeQueryFields,
  kind: z.enum(["candidate", "memory"]).optional(),
  entryId: optionalIdentifier,
  contactId: optionalIdentifier,
  scope: z.enum(["CONTACT_CHANNEL", "REPRESENTATIVE"]).optional(),
  category: z.enum([
    "CONTACT_PREFERENCE",
    "CONTACT_GOAL",
    "CONTACT_CONSTRAINT",
    "CONTACT_CONTEXT",
    "REPRESENTATIVE_RESPONSE_PATTERN",
    "REPRESENTATIVE_SERVICE_PATTERN",
    "REPRESENTATIVE_SAFETY_PATTERN",
    "REPRESENTATIVE_ROUTING_PATTERN",
  ]).optional(),
  status: z.enum([
    "EXTRACTED",
    "QUARANTINED",
    "BLOCKED",
    "PENDING_REVIEW",
    "APPROVED",
    "REJECTED",
    "EXPIRED",
    "ACTIVE",
    "SUPPRESSED",
    "SUPERSEDED",
    "ARCHIVED",
    "DELETE_PENDING",
    "DELETED",
  ]).optional(),
  source: z.enum([
    "AUDIENCE_MESSAGE",
    "VERIFIED_CONTACT_FIELD",
    "OWNER_VERIFIED_CORRECTION",
  ]).optional(),
  channel: z.enum(["WEB", "MATRIX", "TELEGRAM"]).optional(),
  from: optionalIsoDateTime,
  to: optionalIsoDateTime,
  query: optionalQuery,
  asOf: optionalIsoDateTime,
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict();

export const memoryUsageQuerySchema = z.object({
  ...representativeQueryFields,
  contactId: optionalIdentifier,
  conversationId: optionalIdentifier,
  messageId: optionalIdentifier,
  channel: z.enum(["WEB", "MATRIX", "TELEGRAM"]).optional(),
  status: z.enum(["STARTED", "COMPLETED", "DEGRADED", "FAILED", "CANCELED"]).optional(),
  sourceKind: z.enum([
    "PUBLIC_KNOWLEDGE",
    "CONTACT_MEMORY",
    "REPRESENTATIVE_EXPERIENCE",
  ]).optional(),
  from: optionalIsoDateTime,
  to: optionalIsoDateTime,
  asOf: optionalIsoDateTime,
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict();

export const memoryOperationsQuerySchema = z.object({
  ...representativeQueryFields,
  kind: z.enum([
    "extraction",
    "projection",
    "cleanup",
    "public_knowledge_sync",
  ]).optional(),
  status: z.enum([
    "QUEUED",
    "RUNNING",
    "PARTIAL",
    "SUCCEEDED",
    "FAILED",
    "CANCELED",
    "DISABLED",
    "PROJECTING",
    "STAGED",
    "ACTIVE",
    "RETRYING",
    "SUPERSEDED",
    "DELETE_PENDING",
    "DELETING",
    "DELETED",
    "DELETE_FAILED",
    "queued",
    "running",
    "retry_wait",
    "succeeded",
    "failed",
    "disabled",
    "blocked_unpublished",
    "blocked_missing_credentials",
  ]).optional(),
  channel: z.enum(["WEB", "MATRIX", "TELEGRAM"]).optional(),
  from: optionalIsoDateTime,
  to: optionalIsoDateTime,
  asOf: optionalIsoDateTime,
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict();

export const memoryReconciliationQuerySchema = z.object({
  ...representativeQueryFields,
  runId: optionalIdentifier,
  itemCursor: optionalCursor,
  itemLimit: optionalLimit,
  status: z.enum(["QUEUED", "RUNNING", "PARTIAL", "SUCCEEDED", "FAILED", "CANCELED"]).optional(),
  from: optionalIsoDateTime,
  to: optionalIsoDateTime,
  asOf: optionalIsoDateTime,
  cursor: optionalCursor,
  limit: optionalLimit,
}).strict().superRefine((value, context) => {
  if ((value.itemCursor || value.itemLimit) && !value.runId) {
    context.addIssue({
      code: "custom",
      path: [value.itemCursor ? "itemCursor" : "itemLimit"],
      message: "Issue pagination requires a reconciliation runId.",
    });
  }
});

export const memorySettingsQuerySchema = z.object({
  ...representativeQueryFields,
}).strict();

const memoryPolicyShape = z.object({
  basic: z.object({
    longTermMemoryEnabled: z.boolean(),
    contactMemoryEnabled: z.boolean(),
    representativeExperienceEnabled: z.boolean(),
    autoExtract: z.boolean(),
  }).strict(),
  channels: z.object({
    web: z.object({ recallEnabled: z.boolean(), extractEnabled: z.boolean() }).strict(),
    matrix: z.object({ recallEnabled: z.boolean(), extractEnabled: z.boolean() }).strict(),
    telegram: z.object({ recallEnabled: z.boolean(), extractEnabled: z.boolean() }).strict(),
  }).strict(),
  retention: z.object({
    days: z.number().int().min(1).max(3650),
    expiryAction: z.enum(["ARCHIVE", "DELETE"]),
  }).strict(),
  advanced: z.object({
    provider: z.literal("openviking"),
    recallLimit: z.number().int().min(1).max(20),
    recallThreshold: z.number().min(0).max(1),
  }).strict(),
}).strict();

const storedMemorySettingsResultSchema = z.object({
  revision: z.number().int().min(1),
  updatedAt: isoDateTime,
  policy: memoryPolicyShape,
}).strict();

export const memorySettingsUpdateSchema = z.object({
  expectedRevision: z.number().int().min(0),
  policy: memoryPolicyShape,
}).strict().superRefine((value, context) => {
  const { basic, channels } = value.policy;
  const anyRecall = Object.values(channels).some((channel) => channel.recallEnabled);
  const anyExtract = Object.values(channels).some((channel) => channel.extractEnabled);
  if (!basic.longTermMemoryEnabled && (
    basic.contactMemoryEnabled
    || basic.representativeExperienceEnabled
    || basic.autoExtract
    || anyRecall
    || anyExtract
  )) {
    context.addIssue({
      code: "custom",
      path: ["policy", "basic", "longTermMemoryEnabled"],
      message: "Long-term memory must be enabled before dependent capabilities.",
    });
  }
  if (basic.autoExtract && !basic.contactMemoryEnabled) {
    context.addIssue({
      code: "custom",
      path: ["policy", "basic", "autoExtract"],
      message: "Automatic extraction requires Contact Memory.",
    });
  }
  if (anyExtract && (!basic.autoExtract || !basic.contactMemoryEnabled)) {
    context.addIssue({
      code: "custom",
      path: ["policy", "channels"],
      message: "Channel extraction requires automatic Contact Memory extraction.",
    });
  }
  if (
    channels.matrix.recallEnabled
    || channels.matrix.extractEnabled
    || channels.telegram.recallEnabled
    || channels.telegram.extractEnabled
  ) {
    context.addIssue({
      code: "custom",
      path: ["policy", "channels"],
      message: "Matrix and Telegram memory are unavailable until pre-interaction disclosure is supported.",
      params: { reasonCode: "memory_channel_disclosure_unavailable" },
    });
  }
});

const governanceCommandFields = {
  expectedUpdatedAt: isoDateTime,
  reasonCode: z.string().trim().min(1).max(128).regex(reasonCodePattern),
  note: z.string().trim().max(500).optional(),
} as const;

const correctionContactSchema = z.object({
  action: z.literal("request_correction"),
  memoryId: identifier,
  preferenceField: z.enum([
    "reply_length",
    "reply_language",
    "reply_format",
    "reply_tone",
  ]),
  preferenceValue: z.string().trim().min(1).max(64),
  ...governanceCommandFields,
}).strict();

const correctionRepresentativeSchema = z.object({
  action: z.literal("request_correction"),
  memoryId: identifier,
  representativePatternCode: z.enum([
    "response_format_preference",
    "service_goal_confirmation",
    "safety_constraint_confirmation",
  ]),
  ...governanceCommandFields,
}).strict();

export const memoryOperationActionSchema = z.union([
  z.object({ action: z.literal("approve_candidate"), candidateId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("reject_candidate"), candidateId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("block_candidate"), candidateId: identifier, ...governanceCommandFields }).strict(),
  correctionContactSchema,
  correctionRepresentativeSchema,
  z.object({ action: z.literal("suppress_memory"), memoryId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("archive_memory"), memoryId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("restore_memory"), memoryId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("request_deletion"), memoryId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("retry_cleanup"), memoryId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("retry_projection"), projectionItemId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("retry_extraction"), extractionRunId: identifier, ...governanceCommandFields }).strict(),
  z.object({ action: z.literal("enqueue_reconciliation") }).strict(),
]);

export type MemoryOverviewQuery = z.infer<typeof memoryOverviewQuerySchema>;
export type MemoryEntriesQuery = z.infer<typeof memoryEntriesQuerySchema>;
export type MemoryUsageQuery = z.infer<typeof memoryUsageQuerySchema>;
export type MemoryOperationsQuery = z.infer<typeof memoryOperationsQuerySchema>;
export type MemoryReconciliationQuery = z.infer<typeof memoryReconciliationQuerySchema>;
export type MemorySettingsUpdate = z.infer<typeof memorySettingsUpdateSchema>;
export type MemoryOperationAction = z.infer<typeof memoryOperationActionSchema>;

export type MemoryDashboardErrorCode =
  | "memory_dashboard_not_found"
  | "memory_dashboard_forbidden"
  | "memory_dashboard_invalid_cursor"
  | "memory_dashboard_cursor_mismatch"
  | "memory_dashboard_invalid_time_range"
  | "memory_dashboard_version_conflict"
  | "memory_dashboard_idempotency_conflict"
  | "memory_dashboard_state_conflict";

export class MemoryDashboardError extends Error {
  constructor(
    readonly code: MemoryDashboardErrorCode,
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "MemoryDashboardError";
  }
}

type MemoryDashboardClient = PrismaClient;

export type MemoryDashboardOptions = {
  client?: MemoryDashboardClient;
  now?: () => Date;
  healthLoader?: () => Promise<MemoryProviderHealth>;
};

export type MemoryProviderHealth = {
  status: "disabled" | "healthy" | "degraded";
  reasonCode: string | null;
};

type MemoryDashboardActor = {
  actorOwnerId: string;
  representativeId: string;
  representativeSlug: string;
  representativeName: string;
  representativeOwnerId: string;
  activeVersionId: string | null;
  timezone: string;
  role: "OWNER" | "ADMIN" | "REVIEWER";
};

type PageCursor = {
  list: "entries" | "usage" | "operations" | "reconciliation";
  asOf: Date;
  sortAt: Date;
  kind: string;
  id: string;
  scope: string;
};

type PageContext = {
  asOf: Date;
  cursor: PageCursor | null;
  limit: number;
  scope: string;
};

type ReconciliationIssueCursor = {
  asOf: Date;
  createdAt: Date;
  id: string;
  scope: string;
};

export function encodeMemoryDashboardCursor(input: {
  list: PageCursor["list"];
  asOf: Date | string;
  sortAt: Date | string;
  kind: string;
  id: string;
  scope: string;
}) {
  const asOf = parseExactTimestamp(input.asOf, "cursor asOf");
  const sortAt = parseExactTimestamp(input.sortAt, "cursor sortAt");
  if (
    !identifierPattern.test(input.id)
    || !input.kind.trim()
    || !input.scope.trim()
    || input.kind.length > 32
    || input.scope.length > 64
    || !cursorKindAllowed(input.list, input.kind)
    || sortAt > asOf
  ) {
    throw invalidCursor();
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    list: input.list,
    asOf: asOf.toISOString(),
    sortAt: sortAt.toISOString(),
    kind: input.kind,
    id: input.id,
    scope: input.scope,
  }), "utf8").toString("base64url");
}

function encodeReconciliationIssueCursor(input: ReconciliationIssueCursor) {
  return Buffer.from(JSON.stringify({
    v: 1,
    asOf: input.asOf.toISOString(),
    createdAt: input.createdAt.toISOString(),
    id: input.id,
    scope: input.scope,
  }), "utf8").toString("base64url");
}

function decodeReconciliationIssueCursor(
  value: string | undefined,
  expectedScope: string,
) {
  if (!value) return null;
  try {
    if (!cursorPattern.test(value)) throw invalidCursor();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      asOf?: unknown;
      createdAt?: unknown;
      id?: unknown;
      scope?: unknown;
    };
    if (
      parsed.v !== 1
      || typeof parsed.asOf !== "string"
      || typeof parsed.createdAt !== "string"
      || typeof parsed.id !== "string"
      || !identifierPattern.test(parsed.id)
      || typeof parsed.scope !== "string"
    ) {
      throw invalidCursor();
    }
    if (parsed.scope !== expectedScope) {
      throw new MemoryDashboardError(
        "memory_dashboard_cursor_mismatch",
        "The issue cursor does not belong to this reconciliation run.",
        400,
      );
    }
    const asOf = parseExactTimestamp(parsed.asOf, "issue cursor asOf");
    const createdAt = parseExactTimestamp(parsed.createdAt, "issue cursor createdAt");
    if (createdAt > asOf) throw invalidCursor();
    return {
      asOf,
      createdAt,
      id: parsed.id,
      scope: parsed.scope,
    } satisfies ReconciliationIssueCursor;
  } catch (error) {
    if (error instanceof MemoryDashboardError) throw error;
    throw invalidCursor();
  }
}

export function decodeMemoryDashboardCursor(
  value: string | null | undefined,
): PageCursor | null {
  if (!value) return null;
  if (!cursorPattern.test(value)) throw invalidCursor();
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || !new Set(["entries", "usage", "operations", "reconciliation"]).has(String(parsed.list))
      || typeof parsed.asOf !== "string"
      || typeof parsed.sortAt !== "string"
      || typeof parsed.kind !== "string"
      || typeof parsed.id !== "string"
      || typeof parsed.scope !== "string"
      || !identifierPattern.test(parsed.id)
      || !parsed.kind.trim()
      || !parsed.scope.trim()
      || parsed.kind.length > 32
      || parsed.scope.length > 64
    ) {
      throw new Error("invalid shape");
    }
    const list = parsed.list as PageCursor["list"];
    const asOf = parseExactTimestamp(parsed.asOf, "cursor asOf");
    const sortAt = parseExactTimestamp(parsed.sortAt, "cursor sortAt");
    if (!cursorKindAllowed(list, parsed.kind) || sortAt > asOf) {
      throw new Error("invalid cursor ordering");
    }
    return {
      list,
      asOf,
      sortAt,
      kind: parsed.kind,
      id: parsed.id,
      scope: parsed.scope,
    };
  } catch {
    throw invalidCursor();
  }
}

function cursorKindAllowed(list: PageCursor["list"], kind: string) {
  const kinds: Record<PageCursor["list"], ReadonlySet<string>> = {
    entries: new Set(["candidate", "memory"]),
    usage: new Set(["usage"]),
    operations: new Set([
      "cleanup",
      "extraction",
      "projection",
      "public_knowledge_sync",
    ]),
    reconciliation: new Set(["reconciliation"]),
  };
  return kinds[list].has(kind);
}

function invalidCursor() {
  return new MemoryDashboardError(
    "memory_dashboard_invalid_cursor",
    "The memory list cursor is invalid.",
    400,
  );
}

function parseExactTimestamp(value: Date | string, label: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryDashboardError(
      "memory_dashboard_invalid_time_range",
      `Invalid ${label}.`,
      400,
    );
  }
  return date;
}

function stableScope(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function resolveMemoryDashboardActor(
  client: MemoryDashboardClient | Prisma.TransactionClient,
  actorOwnerId: string,
  representativeSlug: string,
): Promise<MemoryDashboardActor> {
  const representative = await client.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      ownerId: true,
      activeVersionId: true,
      owner: { select: { organizationId: true, timezone: true } },
    },
  });
  if (!representative) throw dashboardNotFound();
  if (representative.ownerId === actorOwnerId) {
    return {
      actorOwnerId,
      representativeId: representative.id,
      representativeSlug: representative.slug,
      representativeName: representative.displayName,
      representativeOwnerId: representative.ownerId,
      activeVersionId: representative.activeVersionId,
      timezone: representative.owner.timezone,
      role: "OWNER",
    };
  }

  const actor = await client.owner.findUnique({
    where: { id: actorOwnerId },
    select: {
      organizationId: true,
      timezone: true,
      organizationMember: {
        select: { organizationId: true, role: true },
      },
    },
  });
  const organizationId = representative.owner.organizationId;
  const actorRole = actor?.organizationMember?.role;
  if (
    !organizationId
    || actor?.organizationId !== organizationId
    || actor.organizationMember?.organizationId !== organizationId
    || (
      actorRole !== OrganizationMemberRole.OWNER
      && actorRole !== OrganizationMemberRole.ADMIN
      && actorRole !== OrganizationMemberRole.APPROVER
    )
  ) {
    // Deliberately collapse missing, cross-workspace, and insufficient-role
    // results so callers cannot probe representative existence.
    throw dashboardNotFound();
  }
  return {
    actorOwnerId,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    representativeName: representative.displayName,
    representativeOwnerId: representative.ownerId,
    activeVersionId: representative.activeVersionId,
    timezone: actor.timezone,
    role: actorRole === OrganizationMemberRole.ADMIN
      ? "ADMIN"
      : actorRole === OrganizationMemberRole.APPROVER
        ? "REVIEWER"
        : "OWNER",
  };
}

function dashboardNotFound() {
  return new MemoryDashboardError(
    "memory_dashboard_not_found",
    "Memory workspace not found.",
    404,
  );
}

function dashboardForbidden(message = "This role cannot access this memory operation.") {
  return new MemoryDashboardError(
    "memory_dashboard_forbidden",
    message,
    403,
  );
}

function assertFullMemoryDashboardActor(actor: MemoryDashboardActor) {
  if (actor.role === "REVIEWER") {
    throw dashboardForbidden();
  }
}

function assertMemoryDashboardActionAllowed(
  actor: MemoryDashboardActor,
  action: z.infer<typeof memoryOperationActionSchema>["action"],
) {
  if (
    actor.role === "REVIEWER"
    && action !== "approve_candidate"
    && action !== "reject_candidate"
    && action !== "block_candidate"
  ) {
    throw dashboardForbidden("Reviewers may only review pending memory candidates.");
  }
}

function pageContext(
  list: PageCursor["list"],
  representativeId: string,
  input: {
    asOf?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
  filters: unknown,
  now: Date,
): PageContext {
  const scope = stableScope({ representativeId, filters });
  const cursor = decodeMemoryDashboardCursor(input.cursor);
  if (cursor && (
    cursor.list !== list
    || cursor.scope !== scope
  )) {
    throw new MemoryDashboardError(
      "memory_dashboard_cursor_mismatch",
      "The memory list cursor does not match these filters.",
      400,
    );
  }
  const requestedAsOf = input.asOf
    ? parseExactTimestamp(input.asOf, "asOf")
    : null;
  if (
    cursor
    && requestedAsOf
    && cursor.asOf.getTime() !== requestedAsOf.getTime()
  ) {
    throw new MemoryDashboardError(
      "memory_dashboard_cursor_mismatch",
      "The memory list cursor does not match asOf.",
      400,
    );
  }
  const asOf = cursor?.asOf ?? requestedAsOf ?? now;
  if (asOf.getTime() > now.getTime() + 5 * 60_000) {
    throw new MemoryDashboardError(
      "memory_dashboard_invalid_time_range",
      "asOf cannot be in the future.",
      400,
    );
  }
  const from = input.from ? parseExactTimestamp(input.from, "from") : null;
  const to = input.to ? parseExactTimestamp(input.to, "to") : null;
  if (from && to && from > to) {
    throw new MemoryDashboardError(
      "memory_dashboard_invalid_time_range",
      "from must not be after to.",
      400,
    );
  }
  return {
    asOf,
    cursor,
    limit: input.limit ?? pageSizeDefault,
    scope,
  };
}

function createdAtWindow(input: {
  asOf: Date;
  from?: string;
  to?: string;
}) {
  const requestedTo = input.to
    ? parseExactTimestamp(input.to, "to")
    : input.asOf;
  const upperBound = requestedTo < input.asOf ? requestedTo : input.asOf;
  return {
    ...(input.from
      ? { gte: parseExactTimestamp(input.from, "from") }
      : {}),
    lte: upperBound,
  };
}

function cursorCreatedAtWhere(
  cursor: PageCursor | null,
  kind: string,
) {
  if (!cursor) return {};
  const sameTimestamp = kind < cursor.kind
    ? { createdAt: cursor.sortAt }
    : kind === cursor.kind
      ? { createdAt: cursor.sortAt, id: { lt: cursor.id } }
      : null;
  return {
    OR: [
      { createdAt: { lt: cursor.sortAt } },
      ...(sameTimestamp ? [sameTimestamp] : []),
    ],
  };
}

function comparePageRows(
  left: { sortAt: string; kind: string; id: string },
  right: { sortAt: string; kind: string; id: string },
) {
  return right.sortAt.localeCompare(left.sortAt)
    || right.kind.localeCompare(left.kind)
    || right.id.localeCompare(left.id);
}

function buildPage<T extends { sortAt: string; kind: string; id: string }>(
  list: PageCursor["list"],
  rows: T[],
  context: PageContext,
) {
  rows.sort(comparePageRows);
  const hasMore = rows.length > context.limit;
  const items = rows.slice(0, context.limit);
  const last = items.at(-1);
  return {
    asOf: context.asOf.toISOString(),
    limit: context.limit,
    hasMore,
    nextCursor: hasMore && last
      ? encodeMemoryDashboardCursor({
          list,
          asOf: context.asOf,
          sortAt: last.sortAt,
          kind: last.kind,
          id: last.id,
          scope: context.scope,
        })
      : null,
    items,
  };
}

function contactLabel(
  contact: { displayName: string | null; username: string | null } | null,
) {
  return contact?.displayName?.trim()
    || contact?.username?.trim()
    || "联系人";
}

function inboxHref(input: {
  representativeSlug: string;
  conversationId: string;
  messageId?: string | null;
}) {
  const search = new URLSearchParams({
    view: "inbox",
    rep: input.representativeSlug,
    conversation: input.conversationId,
  });
  if (input.messageId) search.set("message", input.messageId);
  return `/dashboard?${search.toString()}`;
}

function knowledgeHref(representativeSlug: string) {
  return `/dashboard?${new URLSearchParams({
    view: "knowledge",
    rep: representativeSlug,
  }).toString()}`;
}

function settingsHref(representativeSlug: string) {
  return `/dashboard?${new URLSearchParams({
    view: "representatives",
    rep: representativeSlug,
    section: "memory",
  }).toString()}`;
}

function maxDate(values: Array<Date | null | undefined>) {
  const timestamps = values.flatMap((value) => value ? [value.getTime()] : []);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

const memoryRecallVersionSelect = {
  id: true,
  representativeId: true,
  scope: true,
  safeText: true,
  summary: true,
  contentHash: true,
  purgedAt: true,
  deidentifiedAt: true,
  deidentificationMethod: true,
  sourceCandidate: {
    select: {
      representativeId: true,
      contactId: true,
      scope: true,
      scopeChannel: true,
      sourceKind: true,
      status: true,
      contentPurgedAt: true,
      deidentifiedAt: true,
    },
  },
  reviewDecisions: {
    where: { outcome: MemoryReviewOutcome.APPROVED },
    select: {
      representativeId: true,
      outcome: true,
      reviewerRole: true,
    },
  },
  projectionItems: {
    where: {
      lane: MemoryProjectionLane.RECALL,
      status: MemoryProjectionStatus.ACTIVE,
    },
    select: {
      representativeId: true,
      provider: true,
      lane: true,
      status: true,
      contentHash: true,
      remoteUri: true,
      writeReceiptHash: true,
      writeVerifiedAt: true,
      projectedAt: true,
      deleteRequestedAt: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.GovernedMemoryVersionSelect;

const memoryRecallSelect = {
  id: true,
  representativeId: true,
  contactId: true,
  scope: true,
  sourceChannel: true,
  category: true,
  status: true,
  currentVersionId: true,
  recallDisabledAt: true,
  expiresAt: true,
  deleteRequestedAt: true,
  deletedAt: true,
  currentVersion: { select: memoryRecallVersionSelect },
} satisfies Prisma.GovernedMemorySelect;

type RecallMemoryRow = Prisma.GovernedMemoryGetPayload<{
  select: typeof memoryRecallSelect;
}>;

type RecallPolicy = {
  namespaceKey: string;
  provider: string;
  longTermMemoryEnabled: boolean;
  contactMemoryEnabled: boolean;
  representativeExperienceEnabled: boolean;
  webRecallEnabled: boolean;
  matrixRecallEnabled: boolean;
  telegramRecallEnabled: boolean;
};

type RecallEligibilityChannel = {
  enabled: boolean;
  reasonCode: string | null;
};

export type MemoryRecallEligibility = {
  enabled: boolean;
  reasonCode: string | null;
  channels: {
    web: RecallEligibilityChannel;
    matrix: RecallEligibilityChannel;
    telegram: RecallEligibilityChannel;
  };
};

export function evaluateMemoryRecallEligibility(input: {
  memory: RecallMemoryRow;
  policy: RecallPolicy | null;
  now: Date;
}): MemoryRecallEligibility {
  const { memory, policy, now } = input;
  const version = memory.currentVersion;
  let reasonCode: string | null = null;

  if (!policy?.longTermMemoryEnabled) {
    reasonCode = "memory_policy_disabled";
  } else if (
    memory.status !== GovernedMemoryStatus.ACTIVE
    || memory.recallDisabledAt !== null
    || memory.deleteRequestedAt !== null
    || memory.deletedAt !== null
  ) {
    reasonCode = "memory_lifecycle_inactive";
  } else if (memory.expiresAt !== null && memory.expiresAt <= now) {
    reasonCode = "memory_expired";
  } else if (!version || memory.currentVersionId !== version.id) {
    reasonCode = "memory_current_version_missing";
  } else if (
    version.representativeId !== memory.representativeId
    || version.scope !== memory.scope
    || version.purgedAt !== null
    || !version.safeText?.trim()
    || !version.summary?.trim()
  ) {
    reasonCode = "memory_current_version_unavailable";
  } else if (!version.reviewDecisions.some((decision) => (
    decision.representativeId === memory.representativeId
    && decision.outcome === MemoryReviewOutcome.APPROVED
    && decision.reviewerRole !== MemoryReviewerRole.SYSTEM
  ))) {
    reasonCode = "memory_human_approval_missing";
  } else if (
    version.sourceCandidate
    && (
      version.sourceCandidate.representativeId !== memory.representativeId
      || version.sourceCandidate.status !== MemoryCandidateStatus.APPROVED
      || version.sourceCandidate.contentPurgedAt !== null
    )
  ) {
    reasonCode = "memory_source_not_approved";
  } else if (memory.scope === MemoryScope.CONTACT_CHANNEL) {
    if (
      !policy.contactMemoryEnabled
      || !memory.contactId
      || !memory.sourceChannel
      || !memory.category.startsWith("CONTACT_")
      || (
        version.sourceCandidate
        && (
          version.sourceCandidate.scope !== MemoryScope.CONTACT_CHANNEL
          || version.sourceCandidate.contactId !== memory.contactId
          || version.sourceCandidate.scopeChannel !== memory.sourceChannel
        )
      )
    ) {
      reasonCode = "contact_memory_scope_ineligible";
    }
  } else if (
    memory.scope !== MemoryScope.REPRESENTATIVE
    || !policy.representativeExperienceEnabled
    || memory.contactId !== null
    || memory.sourceChannel !== null
    || !memory.category.startsWith("REPRESENTATIVE_")
    || !version.deidentifiedAt
    || !version.deidentificationMethod?.trim()
    || (
      version.sourceCandidate
      && (
        version.sourceCandidate.scope !== MemoryScope.REPRESENTATIVE
        || version.sourceCandidate.contactId !== null
        || version.sourceCandidate.scopeChannel !== null
        || !version.sourceCandidate.deidentifiedAt
      )
    )
  ) {
    reasonCode = "representative_experience_ineligible";
  }

  if (!reasonCode && policy && version) {
    const expectedUri = memory.scope === MemoryScope.CONTACT_CHANNEL
      && memory.contactId
      && memory.sourceChannel
      ? buildGovernedContactChannelMemoryVersionUri({
          namespaceKey: policy.namespaceKey,
          contactId: memory.contactId,
          channel: memory.sourceChannel.toLowerCase() as "web" | "matrix" | "telegram",
          memoryId: memory.id,
          memoryVersionId: version.id,
        })
      : buildGovernedRepresentativeExperienceVersionUri({
          namespaceKey: policy.namespaceKey,
          memoryId: memory.id,
          memoryVersionId: version.id,
        });
    const verifiedProjection = version.projectionItems.some((projection) => (
      projection.representativeId === memory.representativeId
      && projection.provider === policy.provider
      && projection.lane === MemoryProjectionLane.RECALL
      && projection.status === MemoryProjectionStatus.ACTIVE
      && projection.contentHash === version.contentHash
      && projection.remoteUri === expectedUri
      && Boolean(projection.writeReceiptHash)
      && projection.writeVerifiedAt !== null
      && projection.projectedAt !== null
      && projection.deleteRequestedAt === null
      && projection.deletedAt === null
    ));
    if (!verifiedProjection) reasonCode = "memory_projection_not_verified";
  }

  const baseEnabled = reasonCode === null;
  const channelPolicy = {
    web: policy?.webRecallEnabled ?? false,
    matrix: false,
    telegram: false,
  };
  const scopedChannel = memory.scope === MemoryScope.CONTACT_CHANNEL
    ? memory.sourceChannel?.toLowerCase() ?? null
    : null;
  const channels = Object.fromEntries(
    (Object.keys(channelPolicy) as Array<keyof typeof channelPolicy>).map((channel) => {
      const scopeAllows = scopedChannel === null || scopedChannel === channel;
      const enabled = baseEnabled && scopeAllows && channelPolicy[channel];
      return [channel, {
        enabled,
        reasonCode: enabled
          ? null
          : reasonCode
            ?? (!scopeAllows ? "memory_channel_scope_mismatch" : "memory_channel_recall_disabled"),
      }];
    }),
  ) as MemoryRecallEligibility["channels"];
  const enabled = Object.values(channels).some((channel) => channel.enabled);
  return {
    enabled,
    reasonCode: enabled
      ? null
      : reasonCode ?? "memory_all_channels_disabled",
    channels,
  };
}

function startOfDayInTimeZone(now: Date, timeZone: string) {
  try {
    const calendar = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = Object.fromEntries(
      calendar.formatToParts(now)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const year = parts.year;
    const month = parts.month;
    const day = parts.day;
    if (year === undefined || month === undefined || day === undefined) {
      throw new Error("Incomplete zoned calendar date.");
    }
    const targetUtc = Date.UTC(year, month - 1, day);
    let guess = new Date(targetUtc);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const zoned = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      const zonedParts = Object.fromEntries(
        zoned.formatToParts(guess)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, Number(part.value)]),
      );
      const zonedYear = zonedParts.year;
      const zonedMonth = zonedParts.month;
      const zonedDay = zonedParts.day;
      const zonedHour = zonedParts.hour;
      const zonedMinute = zonedParts.minute;
      const zonedSecond = zonedParts.second;
      if (
        zonedYear === undefined
        || zonedMonth === undefined
        || zonedDay === undefined
        || zonedHour === undefined
        || zonedMinute === undefined
        || zonedSecond === undefined
      ) {
        throw new Error("Incomplete zoned clock date.");
      }
      const renderedUtc = Date.UTC(
        zonedYear,
        zonedMonth - 1,
        zonedDay,
        zonedHour,
        zonedMinute,
        zonedSecond,
      );
      guess = new Date(guess.getTime() + targetUtc - renderedUtc);
    }
    return guess;
  } catch {
    const utc = new Date(now);
    utc.setUTCHours(0, 0, 0, 0);
    return utc;
  }
}

function safeReasonCounts(value: Prisma.JsonValue | null) {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  return Object.entries(value)
    .flatMap(([reasonCode, count]) => (
      reasonCodePattern.test(reasonCode)
      && typeof count === "number"
      && Number.isSafeInteger(count)
      && count >= 0
        ? [{ reasonCode, count }]
        : []
    ))
    .sort((left, right) => left.reasonCode.localeCompare(right.reasonCode));
}

export async function getMemoryDashboardSettings(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
  },
  options: MemoryDashboardOptions = {},
) {
  const client = options.client ?? prisma;
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertFullMemoryDashboardActor(actor);
  const policy = await client.representativeMemoryPolicy.findUnique({
    where: { representativeId: actor.representativeId },
  });
  return serializeMemorySettings(actor, policy);
}

export async function updateMemoryDashboardSettings(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    requestId: string;
    idempotencyKey: string;
    update: unknown;
  },
  options: MemoryDashboardOptions = {},
) {
  const parsed = memorySettingsUpdateSchema.parse(input.update);
  const requestId = identifier.parse(input.requestId);
  const idempotencyKey = identifier.parse(input.idempotencyKey);
  const client = options.client ?? prisma;
  const requestHash = sha256({
    operation: "memory_settings_update",
    representativeSlug: input.representativeSlug,
    update: parsed,
  });

  try {
    return await runWithPrismaWriteConflictRetry(
      () => client.$transaction(async (tx) => {
        const actor = await resolveMemoryDashboardActor(
          tx,
          input.actorOwnerId,
          input.representativeSlug,
        );
        assertFullMemoryDashboardActor(actor);
        const replay = await tx.eventAudit.findUnique({
          where: {
            ownerId_idempotencyKey: {
              ownerId: actor.actorOwnerId,
              idempotencyKey,
            },
          },
          select: {
            type: true,
            requestHash: true,
            representativeId: true,
            payload: true,
          },
        });
        if (replay) {
          if (
            replay.type !== EventType.OPENVIKING_CONFIG_CHANGED
            || replay.requestHash !== requestHash
            || replay.representativeId !== actor.representativeId
          ) {
            throw new MemoryDashboardError(
              "memory_dashboard_idempotency_conflict",
              "This idempotency key belongs to a different memory request.",
              409,
            );
          }
          const replayResult = readStoredMemorySettingsResult(replay.payload);
          if (!replayResult) {
            throw new MemoryDashboardError(
              "memory_dashboard_idempotency_conflict",
              "The memory settings replay record is invalid.",
              409,
            );
          }
          return {
            replayed: true,
            requestId,
            settings: serializeMemorySettingsContract({
              actor,
              configured: true,
              revision: replayResult.revision,
              updatedAt: replayResult.updatedAt,
              policy: replayResult.policy,
            }),
          };
        }

        const current = await tx.representativeMemoryPolicy.findUnique({
          where: { representativeId: actor.representativeId },
        });
        if ((current?.revision ?? 0) !== parsed.expectedRevision) {
          throw new MemoryDashboardError(
            "memory_dashboard_version_conflict",
            "Memory settings changed. Reload before saving again.",
            409,
          );
        }
        const policyData = policyUpdateData(parsed.policy);
        let updated;
        if (current) {
          const result = await tx.representativeMemoryPolicy.updateMany({
            where: {
              representativeId: actor.representativeId,
              revision: parsed.expectedRevision,
            },
            data: {
              ...policyData,
              revision: { increment: 1 },
            },
          });
          if (result.count !== 1) {
            throw new MemoryDashboardError(
              "memory_dashboard_version_conflict",
              "Memory settings changed. Reload before saving again.",
              409,
            );
          }
          updated = await tx.representativeMemoryPolicy.findUniqueOrThrow({
            where: { representativeId: actor.representativeId },
          });
        } else {
          if (parsed.expectedRevision !== 0) {
            throw new MemoryDashboardError(
              "memory_dashboard_version_conflict",
              "Memory settings changed. Reload before saving again.",
              409,
            );
          }
          updated = await tx.representativeMemoryPolicy.create({
            data: {
              representativeId: actor.representativeId,
              namespaceKey: managedNamespaceKey(actor.representativeId),
              ...policyData,
              revision: 1,
            },
          });
        }
        const changedFields = memoryPolicyChangedFields(current, updated);
        const settings = serializeMemorySettings(actor, updated);
        await tx.eventAudit.create({
          data: {
            ownerId: actor.actorOwnerId,
            representativeId: actor.representativeId,
            idempotencyKey,
            requestHash,
            type: EventType.OPENVIKING_CONFIG_CHANGED,
            payload: {
              action: "memory_policy_updated",
              requestId,
              actorRole: actor.role,
              changedFields,
              revision: updated.revision,
              result: {
                revision: updated.revision,
                updatedAt: updated.updatedAt.toISOString(),
                policy: parsed.policy,
              },
            },
          },
        });
        return {
          replayed: false,
          requestId,
          settings,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      { additionalRetryableCodes: ["P2002"] },
    );
  } catch (error) {
    if (error instanceof MemoryDashboardError) throw error;
    const code = prismaErrorCode(error);
    if (code === "P2002") {
      throw new MemoryDashboardError(
        "memory_dashboard_version_conflict",
        "Memory settings changed. Reload before saving again.",
        409,
      );
    }
    if (code === "P2034") {
      throw new MemoryDashboardError(
        "memory_dashboard_state_conflict",
        "The memory settings write conflicted with another request.",
        409,
      );
    }
    throw error;
  }
}

function policyUpdateData(policy: z.infer<typeof memoryPolicyShape>) {
  return {
    longTermMemoryEnabled: policy.basic.longTermMemoryEnabled,
    contactMemoryEnabled: policy.basic.contactMemoryEnabled,
    representativeExperienceEnabled:
      policy.basic.representativeExperienceEnabled,
    autoExtract: policy.basic.autoExtract,
    webRecallEnabled: policy.channels.web.recallEnabled,
    webExtractEnabled: policy.channels.web.extractEnabled,
    matrixRecallEnabled: policy.channels.matrix.recallEnabled,
    matrixExtractEnabled: policy.channels.matrix.extractEnabled,
    telegramRecallEnabled: policy.channels.telegram.recallEnabled,
    telegramExtractEnabled: policy.channels.telegram.extractEnabled,
    retentionDays: policy.retention.days,
    expiryAction: policy.retention.expiryAction as MemoryExpiryAction,
    provider: policy.advanced.provider,
    recallLimit: policy.advanced.recallLimit,
    recallScoreThreshold: policy.advanced.recallThreshold,
  };
}

function managedNamespaceKey(representativeId: string) {
  return `mem_${createHash("sha256")
    .update(`delegate-memory:${representativeId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function serializeMemorySettings(
  actor: MemoryDashboardActor,
  policy: Awaited<ReturnType<MemoryDashboardClient["representativeMemoryPolicy"]["findUnique"]>>,
) {
  return serializeMemorySettingsContract({
    actor,
    configured: Boolean(policy),
    revision: policy?.revision ?? 0,
    updatedAt: policy?.updatedAt.toISOString() ?? null,
    policy: {
      basic: {
        longTermMemoryEnabled: policy?.longTermMemoryEnabled ?? false,
        contactMemoryEnabled: policy?.contactMemoryEnabled ?? false,
        representativeExperienceEnabled:
          policy?.representativeExperienceEnabled ?? false,
        autoExtract: policy?.autoExtract ?? false,
      },
      channels: {
        web: {
          recallEnabled: policy?.webRecallEnabled ?? false,
          extractEnabled: policy?.webExtractEnabled ?? false,
        },
        matrix: {
          recallEnabled: policy?.matrixRecallEnabled ?? false,
          extractEnabled: policy?.matrixExtractEnabled ?? false,
        },
        telegram: {
          recallEnabled: policy?.telegramRecallEnabled ?? false,
          extractEnabled: policy?.telegramExtractEnabled ?? false,
        },
      },
      retention: {
        days: policy?.retentionDays ?? 30,
        expiryAction: policy?.expiryAction ?? MemoryExpiryAction.ARCHIVE,
      },
      advanced: {
        provider: "openviking",
        recallLimit: policy?.recallLimit ?? 6,
        recallThreshold: policy?.recallScoreThreshold ?? 0.01,
      },
    },
  });
}

function serializeMemorySettingsContract(input: {
  actor: MemoryDashboardActor;
  configured: boolean;
  revision: number;
  updatedAt: string | null;
  policy: z.infer<typeof memoryPolicyShape>;
}) {
  const { actor, policy } = input;
  const longTermMemoryEnabled = policy.basic.longTermMemoryEnabled;
  const contactMemoryEnabled = longTermMemoryEnabled
    && policy.basic.contactMemoryEnabled;
  const representativeExperienceEnabled = longTermMemoryEnabled
    && policy.basic.representativeExperienceEnabled;
  const autoExtract = contactMemoryEnabled && policy.basic.autoExtract;
  return {
    representative: {
      id: actor.representativeId,
      slug: actor.representativeSlug,
      displayName: actor.representativeName,
    },
    configured: input.configured,
    revision: input.revision,
    basic: {
      longTermMemoryEnabled,
      contactMemoryEnabled,
      representativeExperienceEnabled,
      autoExtract,
      createsCandidatesOnly: true,
      automaticApprovalEnabled: false,
    },
    channels: {
      web: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: longTermMemoryEnabled
          && (contactMemoryEnabled || representativeExperienceEnabled)
          && policy.channels.web.recallEnabled,
        extractEnabled: autoExtract && policy.channels.web.extractEnabled,
      },
      matrix: {
        recallSupported: false,
        extractSupported: false,
        recallEnabled: false,
        extractEnabled: false,
        reasonCode: "memory_channel_disclosure_unavailable",
      },
      telegram: {
        recallSupported: false,
        extractSupported: false,
        recallEnabled: false,
        extractEnabled: false,
        reasonCode: "memory_channel_disclosure_unavailable",
      },
    },
    retention: {
      days: policy.retention.days,
      expiryAction: policy.retention.expiryAction,
    },
    advanced: {
      provider: policy.advanced.provider,
      recallLimit: policy.advanced.recallLimit,
      recallThreshold: policy.advanced.recallThreshold,
      namespaceManagedByServer: true,
      targetManagedByServer: true,
    },
    updatedAt: input.updatedAt,
    settingsHref: settingsHref(actor.representativeSlug),
  };
}

function readStoredMemorySettingsResult(payload: Prisma.JsonValue) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return null;
  }
  return storedMemorySettingsResultSchema.safeParse(payload.result).data ?? null;
}

function memoryPolicyChangedFields(
  current: Awaited<ReturnType<MemoryDashboardClient["representativeMemoryPolicy"]["findUnique"]>>,
  updated: NonNullable<Awaited<ReturnType<MemoryDashboardClient["representativeMemoryPolicy"]["findUnique"]>>>,
) {
  const fields = [
    "longTermMemoryEnabled",
    "contactMemoryEnabled",
    "representativeExperienceEnabled",
    "autoExtract",
    "webRecallEnabled",
    "webExtractEnabled",
    "matrixRecallEnabled",
    "matrixExtractEnabled",
    "telegramRecallEnabled",
    "telegramExtractEnabled",
    "retentionDays",
    "expiryAction",
    "provider",
    "recallLimit",
    "recallScoreThreshold",
  ] as const;
  return fields.filter((field) => current?.[field] !== updated[field]);
}

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

export async function executeMemoryDashboardAction(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    requestId: string;
    idempotencyKey: string;
    action: unknown;
  },
  options: MemoryDashboardOptions = {},
) {
  const action = memoryOperationActionSchema.parse(input.action);
  const requestId = identifier.parse(input.requestId);
  const idempotencyKey = identifier.parse(input.idempotencyKey);
  const client = options.client ?? prisma;
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertMemoryDashboardActionAllowed(actor, action.action);
  if (action.action === "enqueue_reconciliation") {
    return enqueueMemoryDashboardReconciliation({
      actor,
      requestId,
      idempotencyKey,
      client,
      now: options.now?.() ?? new Date(),
    });
  }
  if (
    action.action === "retry_projection"
    || action.action === "retry_extraction"
  ) {
    return retryMemoryDashboardOperation({
      actor,
      requestId,
      idempotencyKey,
      action,
      client,
      now: options.now?.() ?? new Date(),
    });
  }

  const metadata: MemoryGovernanceCommandMetadata = {
    actorOwnerId: actor.actorOwnerId,
    representativeSlug: actor.representativeSlug,
    requestId,
    idempotencyKey,
    expectedUpdatedAt: action.expectedUpdatedAt,
    reasonCode: action.reasonCode,
    ...(action.note ? { note: action.note } : {}),
  };
  const governanceOptions = {
    client,
    ...(options.now ? { now: options.now } : {}),
  };
  let result;
  switch (action.action) {
    case "approve_candidate":
      result = await approveMemoryCandidate({
        ...metadata,
        candidateId: action.candidateId,
      }, governanceOptions);
      break;
    case "reject_candidate":
      result = await rejectMemoryCandidate({
        ...metadata,
        candidateId: action.candidateId,
      }, governanceOptions);
      break;
    case "block_candidate":
      result = await blockMemoryCandidate({
        ...metadata,
        candidateId: action.candidateId,
      }, governanceOptions);
      break;
    case "request_correction":
      result = await requestMemoryCorrection({
        ...metadata,
        memoryId: action.memoryId,
        ...("preferenceField" in action
          ? {
              preferenceField:
                action.preferenceField as ContactMemoryPreferenceField,
              preferenceValue: action.preferenceValue,
            }
          : {
              representativePatternCode:
                action.representativePatternCode as RepresentativeMemoryPatternCode,
            }),
      }, governanceOptions);
      break;
    case "suppress_memory":
      result = await suppressGovernedMemory({
        ...metadata,
        memoryId: action.memoryId,
      }, governanceOptions);
      break;
    case "archive_memory":
      result = await archiveGovernedMemory({
        ...metadata,
        memoryId: action.memoryId,
      }, governanceOptions);
      break;
    case "restore_memory":
      result = await restoreGovernedMemory({
        ...metadata,
        memoryId: action.memoryId,
      }, governanceOptions);
      break;
    case "request_deletion":
      result = await requestGovernedMemoryDeletion({
        ...metadata,
        memoryId: action.memoryId,
      }, governanceOptions);
      break;
    case "retry_cleanup":
      result = await retryGovernedMemoryCleanup({
        ...metadata,
        memoryId: action.memoryId,
      }, governanceOptions);
      break;
  }
  return { requestId, result };
}

type RetryMemoryDashboardAction = Extract<
  MemoryOperationAction,
  { action: "retry_projection" | "retry_extraction" }
>;

const retryMemoryDashboardAuditResultSchema = z.object({
  representativeId: identifier,
  action: z.enum(["retry_projection", "retry_extraction"]),
  target: z.object({
    kind: z.enum(["projection", "extraction"]),
    id: identifier,
  }).strict(),
  status: z.string().trim().min(1).max(64),
  previousStatus: z.string().trim().min(1).max(64),
  previousAttemptCount: z.number().int().min(0),
  previousErrorCode: z.string().trim().min(1).max(191).nullable(),
  updatedAt: isoDateTime,
}).strict();

function parseRetryExtractionCoordinates(idempotencyKey: string) {
  const [prefix, version, trigger, scope, channel, revisionDigest, requestDigest] =
    idempotencyKey.split(":");
  if (
    prefix !== "memory-extraction"
    || version !== "v1"
    || (scope !== MemoryScope.CONTACT_CHANNEL && scope !== MemoryScope.REPRESENTATIVE)
    || (channel !== "web" && channel !== "matrix" && channel !== "telegram")
    || !revisionDigest
    || !/^[0-9a-f]{64}$/u.test(revisionDigest)
    || !requestDigest
    || !/^[0-9a-f]{64}$/u.test(requestDigest)
    || !Object.values(MemoryExtractionTrigger).includes(
      trigger as MemoryExtractionTrigger,
    )
  ) {
    return null;
  }
  return {
    trigger: trigger as MemoryExtractionTrigger,
    scope,
    channel,
    revisionDigest,
  };
}

async function retryMemoryDashboardOperation(input: {
  actor: MemoryDashboardActor;
  requestId: string;
  idempotencyKey: string;
  action: RetryMemoryDashboardAction;
  client: MemoryDashboardClient;
  now: Date;
}) {
  const targetId = input.action.action === "retry_projection"
    ? input.action.projectionItemId
    : input.action.extractionRunId;
  const expectedUpdatedAt = parseExactTimestamp(
    input.action.expectedUpdatedAt,
    "expectedUpdatedAt",
  );
  const requestHash = sha256({
    operation: input.action.action,
    representativeSlug: input.actor.representativeSlug,
    targetId,
    expectedUpdatedAt: expectedUpdatedAt.toISOString(),
    reasonCode: input.action.reasonCode,
    note: input.action.note ?? null,
  });

  try {
    return await runWithPrismaWriteConflictRetry(
      () => input.client.$transaction(async (tx) => {
        const actor = await resolveMemoryDashboardActor(
          tx,
          input.actor.actorOwnerId,
          input.actor.representativeSlug,
        );
        assertFullMemoryDashboardActor(actor);
        const replay = await tx.eventAudit.findUnique({
          where: {
            ownerId_idempotencyKey: {
              ownerId: actor.actorOwnerId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          select: { type: true, requestHash: true, payload: true },
        });
        if (replay) {
          const parsed = replay.type === EventType.OPENVIKING_MEMORY_STATUS_CHANGED
            && replay.requestHash === requestHash
            && replay.payload
            && !Array.isArray(replay.payload)
            && typeof replay.payload === "object"
            ? retryMemoryDashboardAuditResultSchema.safeParse(
                replay.payload.result,
              ).data
            : null;
          if (!parsed || parsed.representativeId !== actor.representativeId) {
            throw new MemoryDashboardError(
              "memory_dashboard_idempotency_conflict",
              "This idempotency key belongs to a different memory operation.",
              409,
            );
          }
          return {
            requestId: input.requestId,
            result: { ...parsed, replayed: true },
          };
        }

        let result: z.infer<typeof retryMemoryDashboardAuditResultSchema>;
        if (input.action.action === "retry_projection") {
          const projection = await tx.memoryProjectionItem.findFirst({
            where: {
              id: input.action.projectionItemId,
              representativeId: actor.representativeId,
            },
            select: {
              id: true,
              representativeId: true,
              memoryId: true,
              memoryVersionId: true,
              provider: true,
              lane: true,
              status: true,
              contentHash: true,
              remoteUri: true,
              deleteRequestedAt: true,
              deletedAt: true,
              attemptCount: true,
              lastErrorCode: true,
              updatedAt: true,
            },
          });
          if (!projection) throw dashboardNotFound();
          if (projection.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
            throw new MemoryDashboardError(
              "memory_dashboard_version_conflict",
              "The projection changed since it was loaded.",
              409,
            );
          }
          if (
            projection.status !== MemoryProjectionStatus.FAILED
            || projection.lane !== MemoryProjectionLane.RECALL
            || projection.deleteRequestedAt !== null
            || projection.deletedAt !== null
          ) {
            throw new MemoryDashboardError(
              "memory_dashboard_state_conflict",
              "Only a failed, current recall projection can be retried.",
              409,
            );
          }
          const [memory, policy] = await Promise.all([
            tx.governedMemory.findFirst({
              where: {
                id: projection.memoryId,
                representativeId: actor.representativeId,
              },
              select: memoryRecallSelect,
            }),
            tx.representativeMemoryPolicy.findUnique({
              where: { representativeId: actor.representativeId },
            }),
          ]);
          if (
            !memory
            || !memory.currentVersion
            || memory.currentVersion.id !== projection.memoryVersionId
            || memory.currentVersion.contentHash !== projection.contentHash
          ) {
            throw new MemoryDashboardError(
              "memory_dashboard_state_conflict",
              "The failed projection is no longer the authoritative memory version.",
              409,
            );
          }
          // The failed item itself cannot satisfy the ACTIVE projection gate.
          // Substitute only that single gate for preflight; current-version,
          // content hash, exact URI, human approval, lifecycle, kind, policy,
          // and channel checks below still use authoritative database values.
          const preflightMemory: RecallMemoryRow = {
            ...memory,
            currentVersion: {
              ...memory.currentVersion,
              projectionItems: [{
                representativeId: projection.representativeId,
                provider: projection.provider,
                lane: MemoryProjectionLane.RECALL,
                status: MemoryProjectionStatus.ACTIVE,
                contentHash: projection.contentHash,
                remoteUri: projection.remoteUri,
                writeReceiptHash: "retry-preflight",
                writeVerifiedAt: input.now,
                projectedAt: input.now,
                deleteRequestedAt: null,
                deletedAt: null,
              }],
            },
          };
          if (!evaluateMemoryRecallEligibility({
            memory: preflightMemory,
            policy,
            now: input.now,
          }).enabled) {
            throw new MemoryDashboardError(
              "memory_dashboard_state_conflict",
              "The memory is no longer eligible for recall projection.",
              409,
            );
          }
          const updated = await tx.memoryProjectionItem.updateMany({
            where: {
              id: projection.id,
              representativeId: actor.representativeId,
              status: MemoryProjectionStatus.FAILED,
              updatedAt: expectedUpdatedAt,
            },
            data: {
              status: MemoryProjectionStatus.QUEUED,
              attemptCount: 0,
              availableAt: input.now,
              leaseToken: null,
              leaseExpiresAt: null,
              lastErrorCode: null,
            },
          });
          if (updated.count !== 1) {
            throw new MemoryDashboardError(
              "memory_dashboard_version_conflict",
              "The projection changed while the retry was queued.",
              409,
            );
          }
          const stored = await tx.memoryProjectionItem.findFirst({
            where: {
              id: projection.id,
              representativeId: actor.representativeId,
            },
            select: { status: true, updatedAt: true },
          });
          if (!stored) throw dashboardNotFound();
          result = {
            representativeId: actor.representativeId,
            action: "retry_projection",
            target: { kind: "projection", id: projection.id },
            status: stored.status,
            previousStatus: projection.status,
            previousAttemptCount: projection.attemptCount,
            previousErrorCode: projection.lastErrorCode,
            updatedAt: stored.updatedAt.toISOString(),
          };
        } else {
          const run = await tx.memoryExtractionRun.findFirst({
            where: {
              id: input.action.extractionRunId,
              representativeId: actor.representativeId,
            },
            select: {
              id: true,
              status: true,
              contactId: true,
              sourceChannel: true,
              sourceConversationId: true,
              sourceMessageId: true,
              trigger: true,
              idempotencyKey: true,
              attemptCount: true,
              errorCode: true,
              updatedAt: true,
            },
          });
          if (!run) throw dashboardNotFound();
          if (run.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
            throw new MemoryDashboardError(
              "memory_dashboard_version_conflict",
              "The extraction changed since it was loaded.",
              409,
            );
          }
          if (
            run.status !== MemoryExtractionStatus.FAILED
            || !run.contactId
            || !run.sourceConversationId
            || !run.sourceMessageId
          ) {
            throw new MemoryDashboardError(
              "memory_dashboard_state_conflict",
              "Only a failed extraction with immutable source coordinates can be retried.",
              409,
            );
          }
          const coordinates = parseRetryExtractionCoordinates(run.idempotencyKey);
          if (
            !coordinates
            || coordinates.trigger !== run.trigger
            || coordinates.channel !== run.sourceChannel.toLowerCase()
            || coordinates.channel !== "web"
            || run.sourceChannel !== RepresentativeChannelKind.WEB
          ) {
            throw new MemoryDashboardError(
              "memory_dashboard_state_conflict",
              "The extraction channel or immutable coordinates are not eligible for retry.",
              409,
            );
          }
          const [source, extractionPolicy] = await Promise.all([
            tx.message.findFirst({
            where: {
              id: run.sourceMessageId,
              conversationId: run.sourceConversationId,
              conversation: {
                is: {
                  representativeId: actor.representativeId,
                  contactId: run.contactId,
                },
              },
            },
            select: {
              id: true,
              conversationId: true,
              senderType: true,
              contentType: true,
              text: true,
              editedAt: true,
              redactedAt: true,
              conversation: {
                select: {
                  representativeId: true,
                  contactId: true,
                  sourceChannel: true,
                },
              },
            },
            }),
            tx.representativeMemoryPolicy.findUnique({
              where: { representativeId: actor.representativeId },
              select: {
                longTermMemoryEnabled: true,
                contactMemoryEnabled: true,
                representativeExperienceEnabled: true,
                autoExtract: true,
                webExtractEnabled: true,
                matrixExtractEnabled: true,
                telegramExtractEnabled: true,
                retentionDays: true,
              },
            }),
          ]);
          const policyGate = resolveMemoryExtractionPolicyGate(
            extractionPolicy,
            coordinates.channel,
            coordinates.trigger,
            coordinates.scope,
          );
          if (
            !source
            || source.conversationId !== run.sourceConversationId
            || source.conversation.representativeId !== actor.representativeId
            || source.conversation.contactId !== run.contactId
            || source.conversation.sourceChannel?.trim().toLowerCase()
              !== coordinates.channel
            || source.senderType !== MessageSenderType.AUDIENCE
            || source.contentType !== MessageContentType.TEXT
            || !source.text?.trim()
            || source.editedAt !== null
            || source.redactedAt !== null
            || sha256Text(`${source.id}\u0000${source.text ?? ""}`)
              !== coordinates.revisionDigest
            || !policyGate.allowed
          ) {
            throw new MemoryDashboardError(
              "memory_dashboard_state_conflict",
              "The extraction source or policy is no longer eligible for retry.",
              409,
            );
          }
          const updated = await tx.memoryExtractionRun.updateMany({
            where: {
              id: run.id,
              representativeId: actor.representativeId,
              status: MemoryExtractionStatus.FAILED,
              updatedAt: expectedUpdatedAt,
            },
            data: {
              status: MemoryExtractionStatus.QUEUED,
              attemptCount: 0,
              availableAt: input.now,
              leaseToken: null,
              leaseExpiresAt: null,
              startedAt: null,
              finishedAt: null,
              errorCode: null,
            },
          });
          if (updated.count !== 1) {
            throw new MemoryDashboardError(
              "memory_dashboard_version_conflict",
              "The extraction changed while the retry was queued.",
              409,
            );
          }
          const stored = await tx.memoryExtractionRun.findFirst({
            where: {
              id: run.id,
              representativeId: actor.representativeId,
            },
            select: { status: true, updatedAt: true },
          });
          if (!stored) throw dashboardNotFound();
          result = {
            representativeId: actor.representativeId,
            action: "retry_extraction",
            target: { kind: "extraction", id: run.id },
            status: stored.status,
            previousStatus: run.status,
            previousAttemptCount: run.attemptCount,
            previousErrorCode: run.errorCode,
            updatedAt: stored.updatedAt.toISOString(),
          };
        }

        await tx.eventAudit.create({
          data: {
            ownerId: actor.actorOwnerId,
            representativeId: actor.representativeId,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            type: EventType.OPENVIKING_MEMORY_STATUS_CHANGED,
            payload: {
              requestId: input.requestId,
              actorRole: actor.role,
              reasonCode: input.action.reasonCode,
              result,
            },
          },
        });
        return {
          requestId: input.requestId,
          result: { ...result, replayed: false },
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      { additionalRetryableCodes: ["P2002"] },
    );
  } catch (error) {
    if (error instanceof MemoryDashboardError) throw error;
    if (prismaErrorCode(error) === "P2002") {
      throw new MemoryDashboardError(
        "memory_dashboard_idempotency_conflict",
        "The retry conflicts with an existing request.",
        409,
      );
    }
    throw error;
  }
}

async function enqueueMemoryDashboardReconciliation(input: {
  actor: MemoryDashboardActor;
  requestId: string;
  idempotencyKey: string;
  client: MemoryDashboardClient;
  now: Date;
}) {
  const requestHash = sha256({
    operation: "enqueue_memory_reconciliation",
    representativeSlug: input.actor.representativeSlug,
  });
  try {
    return await runWithPrismaWriteConflictRetry(
      () => input.client.$transaction(async (tx) => {
        // Re-resolve inside the serializable transaction. The representative
        // may have changed workspace ownership after the route preflight.
        const actor = await resolveMemoryDashboardActor(
          tx,
          input.actor.actorOwnerId,
          input.actor.representativeSlug,
        );
        assertFullMemoryDashboardActor(actor);
        const auditReplay = await tx.eventAudit.findUnique({
          where: {
            ownerId_idempotencyKey: {
              ownerId: actor.actorOwnerId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          select: { type: true, requestHash: true, payload: true },
        });
        if (auditReplay) {
          const result = auditReplay.payload
            && !Array.isArray(auditReplay.payload)
            && typeof auditReplay.payload === "object"
            && auditReplay.type === EventType.OPENVIKING_CONFIG_CHANGED
            && auditReplay.requestHash === requestHash
            ? z.object({
                representativeId: identifier,
                action: z.literal("enqueue_reconciliation"),
                runId: identifier,
                status: z.string().min(1).max(64),
                createdAt: isoDateTime,
              }).strict().safeParse(auditReplay.payload.result).data
            : null;
          if (!result || result.representativeId !== actor.representativeId) {
            throw new MemoryDashboardError(
              "memory_dashboard_idempotency_conflict",
              "This idempotency key belongs to a different memory request.",
              409,
            );
          }
          return {
            requestId: input.requestId,
            result: { ...result, replayed: true },
          };
        }
        const runIdempotencyKey = `manual:${input.idempotencyKey}`;
        const replay = await tx.memoryReconciliationRun.findUnique({
          where: {
            representativeId_idempotencyKey: {
              representativeId: actor.representativeId,
              idempotencyKey: runIdempotencyKey,
            },
          },
          select: { id: true, status: true, createdAt: true },
        });
        if (replay) {
          const result = {
            representativeId: actor.representativeId,
            action: "enqueue_reconciliation" as const,
            runId: replay.id,
            status: replay.status,
            createdAt: replay.createdAt.toISOString(),
          };
          await tx.eventAudit.create({
            data: {
              ownerId: actor.actorOwnerId,
              representativeId: actor.representativeId,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              type: EventType.OPENVIKING_CONFIG_CHANGED,
              payload: {
                requestId: input.requestId,
                actorRole: actor.role,
                reasonCode: "manual_memory_reconciliation_requested",
                result,
              },
            },
          });
          return {
            requestId: input.requestId,
            result: {
              ...result,
              replayed: true,
            },
          };
        }
        const active = await tx.memoryReconciliationRun.findFirst({
          where: {
            representativeId: actor.representativeId,
            status: { in: [
              MemoryReconciliationStatus.QUEUED,
              MemoryReconciliationStatus.RUNNING,
            ] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        });
        if (active) {
          throw new MemoryDashboardError(
            "memory_dashboard_state_conflict",
            "A memory reconciliation run is already active.",
            409,
          );
        }
        const policy = await tx.representativeMemoryPolicy.findUnique({
          where: { representativeId: actor.representativeId },
          select: { provider: true },
        });
        if (!policy) {
          throw new MemoryDashboardError(
            "memory_dashboard_state_conflict",
            "Configure governed memory before starting reconciliation.",
            409,
          );
        }
        const run = await tx.memoryReconciliationRun.create({
          data: {
            representativeId: actor.representativeId,
            provider: policy.provider,
            status: MemoryReconciliationStatus.QUEUED,
            idempotencyKey: runIdempotencyKey,
            asOf: input.now,
            availableAt: input.now,
          },
          select: { id: true, status: true, createdAt: true },
        });
        const result = {
          representativeId: actor.representativeId,
          action: "enqueue_reconciliation" as const,
          runId: run.id,
          status: run.status,
          createdAt: run.createdAt.toISOString(),
        };
        await tx.eventAudit.create({
          data: {
            ownerId: actor.actorOwnerId,
            representativeId: actor.representativeId,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            type: EventType.OPENVIKING_CONFIG_CHANGED,
            payload: {
              requestId: input.requestId,
              actorRole: actor.role,
              reasonCode: "manual_memory_reconciliation_requested",
              result,
            },
          },
        });
        return {
          requestId: input.requestId,
          result: {
            ...result,
            replayed: false,
          },
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      { additionalRetryableCodes: ["P2002"] },
    );
  } catch (error) {
    if (error instanceof MemoryDashboardError) throw error;
    if (prismaErrorCode(error) === "P2002") {
      throw new MemoryDashboardError(
        "memory_dashboard_idempotency_conflict",
        "The reconciliation request conflicts with an existing request.",
        409,
      );
    }
    throw error;
  }
}

const publicAggregateResourceKeys = {
  identity: "identity/profile.md",
  faq: "faq/index.md",
  materials: "materials/index.md",
  policies: "policies/index.md",
  pricing: "pricing/index.md",
} as const;

const publicSyncAttentionStatuses = new Set([
  "retry_wait",
  "failed",
  "blocked_unpublished",
  "blocked_missing_credentials",
]);

type ExpectedPublicProjection = {
  resourceKey: string;
  sourceKind: PublicKnowledgeProjectionSourceKind;
  knowledgeAssetId: string | null;
  contentHash: string;
  remoteUri: string;
  authoritative: boolean;
};

async function loadPublicKnowledgeProjectionHealth(input: {
  client: MemoryDashboardClient;
  actor: MemoryDashboardActor;
}) {
  if (!input.actor.activeVersionId) {
    return {
      projectionStatus: "unpublished" as const,
      expectedItemCount: 0,
      projectedItemCount: 0,
      verifiedItemCount: 0,
      missingItemCount: 0,
      mismatchedItemCount: 0,
      unexpectedItemCount: 0,
      hashTruth: "not_applicable" as const,
      syncStatus: null,
      syncItemCount: 0,
      syncItemCountMatches: true,
      syncErrorCode: null,
      anomalyCount: 0,
      lastProjectedAt: null,
      lastUpdatedAt: null,
    };
  }

  const publishedVersionId = input.actor.activeVersionId;
  const [version, ledger, latestSync] = await Promise.all([
    input.client.representativeVersion.findFirst({
      where: {
        id: publishedVersionId,
        representativeId: input.actor.representativeId,
      },
      select: { snapshot: true, publishedAt: true },
    }),
    input.client.publicKnowledgeProjectionItem.findMany({
      where: {
        representativeId: input.actor.representativeId,
        publishedVersionId,
        provider: "openviking",
      },
      select: {
        sourceKind: true,
        resourceKey: true,
        knowledgeAssetId: true,
        provider: true,
        contentHash: true,
        remoteUri: true,
        projectedAt: true,
        createdAt: true,
      },
    }),
    input.client.representativeContextSync.findFirst({
      where: {
        representativeId: input.actor.representativeId,
        requestedVersionId: publishedVersionId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        status: true,
        itemCount: true,
        updatedAt: true,
        finishedAt: true,
      },
    }),
  ]);

  const parsedSnapshot = publicKnowledgeSnapshotSchema.safeParse(version?.snapshot);
  const expected: ExpectedPublicProjection[] = [];
  if (parsedSnapshot.success) {
    const snapshot = parsedSnapshot.data;
    const knowledge = snapshot.knowledge ?? {
      identitySummary: "",
      faq: [],
      materials: [],
      policies: [],
    };
    const normalizeDocuments = (
      documents: Array<{ title: string; summary: string; url?: string | undefined }>,
    ) => documents.map((document) => ({
      title: document.title,
      summary: document.summary,
      ...(document.url ? { url: document.url } : {}),
    }));
    const documents = buildRepresentativeKnowledgeDocuments({
      slug: input.actor.representativeSlug,
      representativeVersionId: publishedVersionId,
      name: snapshot.identity.displayName,
      tagline: snapshot.identity.roleSummary,
      tone: snapshot.identity.tone,
      languages: snapshot.identity.languages,
      groupActivation: snapshot.groupActivation,
      publicMode: snapshot.publicMode,
      humanInLoop: snapshot.humanInLoop,
      freeReplyLimit: snapshot.conversation.freeReplyLimit,
      freeScope: snapshot.conversation.freeScope,
      paywalledIntents: snapshot.conversation.paywalledIntents,
      handoffWindowHours: snapshot.conversation.handoffWindowHours,
      skills: snapshot.governance.allowedSkills,
      knowledgePack: {
        identitySummary: knowledge.identitySummary,
        faq: normalizeDocuments(knowledge.faq),
        materials: normalizeDocuments(knowledge.materials),
        policies: normalizeDocuments(knowledge.policies),
      },
      pricing: snapshot.pricing,
      handoffPrompt: snapshot.conversation.handoffPrompt,
    });
    for (const document of documents) {
      const resourceKey = publicAggregateResourceKeys[
        document.category as keyof typeof publicAggregateResourceKeys
      ];
      if (!resourceKey) continue;
      expected.push({
        resourceKey,
        sourceKind: PublicKnowledgeProjectionSourceKind.REPRESENTATIVE_VERSION_RESOURCE,
        knowledgeAssetId: null,
        contentHash: sha256Text(document.content),
        remoteUri: document.uri,
        authoritative: true,
      });
    }

    const pins = snapshot.knowledgeAssets;
    const assets = pins.length
      ? await input.client.knowledgeAsset.findMany({
          where: { id: { in: pins.map((pin) => pin.assetId) } },
          select: {
            id: true,
            ownerId: true,
            status: true,
            archivedAt: true,
            checksum: true,
            processingVersion: true,
            extractedText: true,
          },
        })
      : [];
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const duplicatePins = new Set<string>();
    const seenPins = new Set<string>();
    for (const pin of pins) {
      if (seenPins.has(pin.assetId)) duplicatePins.add(pin.assetId);
      seenPins.add(pin.assetId);
      const asset = assetsById.get(pin.assetId);
      const pinnedHash = pin.checksum ?? "";
      expected.push({
        resourceKey: `knowledge/${pin.assetId}.md`,
        sourceKind: PublicKnowledgeProjectionSourceKind.KNOWLEDGE_ASSET,
        knowledgeAssetId: pin.assetId,
        contentHash: pinnedHash,
        remoteUri: buildRepresentativeVersionKnowledgeAssetUri(
          input.actor.representativeSlug,
          publishedVersionId,
          pin.assetId,
        ),
        authoritative: !duplicatePins.has(pin.assetId)
          && Boolean(asset)
          && asset?.ownerId === input.actor.representativeOwnerId
          && asset.status === KnowledgeAssetStatus.READY
          && asset.archivedAt === null
          && Boolean(asset.extractedText)
          && asset.checksum === pinnedHash
          && asset.processingVersion === pin.processingVersion
          && sha256Text(asset.extractedText ?? "") === pinnedHash,
      });
    }
  }

  const ledgerByResourceKey = new Map(
    ledger.map((item) => [item.resourceKey, item]),
  );
  let verifiedItemCount = 0;
  let missingItemCount = 0;
  let mismatchedItemCount = 0;
  for (const spec of expected) {
    const item = ledgerByResourceKey.get(spec.resourceKey);
    if (!item) {
      missingItemCount += 1;
      continue;
    }
    if (
      spec.authoritative
      && item.sourceKind === spec.sourceKind
      && item.knowledgeAssetId === spec.knowledgeAssetId
      && item.provider === "openviking"
      && item.contentHash === spec.contentHash
      && item.remoteUri === spec.remoteUri
      && item.projectedAt !== null
    ) {
      verifiedItemCount += 1;
    } else {
      mismatchedItemCount += 1;
    }
  }
  const expectedKeys = new Set(expected.map((item) => item.resourceKey));
  const unexpectedItemCount = ledger.filter(
    (item) => !expectedKeys.has(item.resourceKey),
  ).length;
  if (!parsedSnapshot.success) mismatchedItemCount += Math.max(1, ledger.length);
  const fullyVerified = parsedSnapshot.success
    && expected.length > 0
    && verifiedItemCount === expected.length
    && mismatchedItemCount === 0
    && unexpectedItemCount === 0;
  const syncItemCountMismatch = Boolean(
    latestSync?.status === "succeeded"
    && (
      latestSync.itemCount !== expected.length
      || latestSync.itemCount !== verifiedItemCount
    ),
  );
  const syncNeedsAttention = syncItemCountMismatch || Boolean(
    latestSync && publicSyncAttentionStatuses.has(latestSync.status),
  );
  const projectionStatus = syncNeedsAttention
    ? latestSync?.status === "retry_wait"
      ? "retrying"
      : latestSync?.status?.startsWith("blocked_")
        ? "blocked"
        : "failed"
    : fullyVerified
      ? "projected"
      : verifiedItemCount > 0
        ? "partial"
        : latestSync?.status === "queued" || latestSync?.status === "running"
          ? "syncing"
          : "empty";
  const latestProjectedAt = ledger.reduce<Date | null>(
    (latest, item) => !latest || item.projectedAt > latest ? item.projectedAt : latest,
    null,
  );
  return {
    projectionStatus,
    expectedItemCount: expected.length,
    projectedItemCount: ledger.length,
    verifiedItemCount,
    missingItemCount,
    mismatchedItemCount,
    unexpectedItemCount,
    hashTruth: fullyVerified ? "verified" as const : "mismatch_or_incomplete" as const,
    syncStatus: latestSync?.status ?? null,
    syncItemCount: latestSync?.itemCount ?? 0,
    syncItemCountMatches: !syncItemCountMismatch,
    syncErrorCode: syncNeedsAttention && latestSync
      ? syncItemCountMismatch
        ? "public_knowledge_sync_item_count_mismatch"
        : `public_knowledge_sync_${latestSync.status}`
      : null,
    anomalyCount: (
      missingItemCount
      + mismatchedItemCount
      + unexpectedItemCount
      + (syncNeedsAttention ? 1 : 0)
    ),
    lastProjectedAt: latestProjectedAt,
    lastUpdatedAt: maxDateValue([
      version?.publishedAt,
      latestProjectedAt,
      latestSync?.updatedAt,
      latestSync?.finishedAt,
    ]),
  };
}

async function loadMemoryProviderHealth(): Promise<MemoryProviderHealth> {
  const env = resolveOpenVikingEnv();
  if (!env.enabled) {
    return { status: "disabled", reasonCode: "openviking_environment_disabled" };
  }
  if (!env.hasModelCredentials) {
    return { status: "degraded", reasonCode: "openviking_model_credentials_missing" };
  }
  try {
    const client = new OpenVikingClient({
      baseUrl: env.baseUrl,
      ...(env.apiKey ? { apiKey: env.apiKey } : {}),
      timeoutMs: env.timeoutMs,
      accountId: "delegate",
      userId: "owner-dashboard",
      agentId: "delegate-dashboard",
    });
    await client.health();
    return { status: "healthy", reasonCode: null };
  } catch {
    return { status: "degraded", reasonCode: "openviking_health_unreachable" };
  }
}

function maxDateValue(values: Array<Date | null | undefined>) {
  const timestamps = values.flatMap((value) => value ? [value.getTime()] : []);
  return timestamps.length ? new Date(Math.max(...timestamps)) : null;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function getMemoryDashboardOverview(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
  },
  options: MemoryDashboardOptions = {},
) {
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertFullMemoryDashboardActor(actor);
  const today = startOfDayInTimeZone(now, actor.timezone);
  const policy = await client.representativeMemoryPolicy.findUnique({
    where: { representativeId: actor.representativeId },
  });
  const stageWindow = { gte: today, lte: now };
  const useItemForRepresentative = {
    useRun: { is: { representativeId: actor.representativeId } },
  } as const;
  const [
    recallMemoryRows,
    pendingCandidateCount,
    todayQuestions,
    todaySearchHits,
    todayScopePassed,
    todaySafetyPassed,
    todayInjected,
    todayCited,
    todayDisplayed,
    answersUsingMemory,
    projectionAnomalies,
    cleanupAnomalies,
    reconciliationAnomalies,
    latestMemory,
    latestCandidate,
    latestUse,
    latestUseItem,
    latestProjection,
    latestReconciliation,
    publicProjectionHealth,
    health,
  ] = await Promise.all([
    client.governedMemory.findMany({
      where: {
        representativeId: actor.representativeId,
        status: GovernedMemoryStatus.ACTIVE,
        recallDisabledAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: memoryRecallSelect,
    }),
    client.memoryCandidate.count({
      where: {
        representativeId: actor.representativeId,
        status: MemoryCandidateStatus.PENDING_REVIEW,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    client.memoryUseRun.count({
      where: {
        representativeId: actor.representativeId,
        startedAt: stageWindow,
      },
    }),
    client.memoryUseItem.count({
      where: {
        ...useItemForRepresentative,
        searchedAt: stageWindow,
      },
    }),
    client.memoryUseItem.count({
      where: {
        ...useItemForRepresentative,
        scopePassedAt: stageWindow,
      },
    }),
    client.memoryUseItem.count({
      where: {
        ...useItemForRepresentative,
        safetyPassedAt: stageWindow,
      },
    }),
    client.memoryUseItem.count({
      where: {
        ...useItemForRepresentative,
        injectedAt: stageWindow,
      },
    }),
    client.memoryUseItem.count({
      where: {
        ...useItemForRepresentative,
        citedAt: stageWindow,
      },
    }),
    client.memoryUseItem.count({
      where: {
        ...useItemForRepresentative,
        displayedAt: stageWindow,
      },
    }),
    client.memoryUseRun.count({
      where: {
        representativeId: actor.representativeId,
        status: { in: [
          MemoryUseRunStatus.COMPLETED,
          MemoryUseRunStatus.DEGRADED,
        ] },
        completedAt: stageWindow,
        outputMessageId: { not: null },
        outputMessage: {
          is: {
            deliveryStatus: { in: [
              MessageDeliveryStatus.ACCEPTED,
              MessageDeliveryStatus.QUEUED,
              MessageDeliveryStatus.PROCESSING,
              MessageDeliveryStatus.SENT,
            ] },
          },
        },
        items: { some: { injectedAt: { not: null } } },
      },
    }),
    client.memoryProjectionItem.count({
      where: {
        representativeId: actor.representativeId,
        status: { in: [
          MemoryProjectionStatus.FAILED,
          MemoryProjectionStatus.DELETE_FAILED,
        ] },
      },
    }),
    client.memoryDeletionProof.count({
      where: {
        representativeId: actor.representativeId,
        cleanupStatus: MemoryCleanupStatus.FAILED,
      },
    }),
    client.memoryReconciliationItem.count({
      where: {
        representativeId: actor.representativeId,
        status: { in: ["OPEN", "FAILED"] },
      },
    }),
    client.governedMemory.aggregate({
      where: { representativeId: actor.representativeId },
      _max: { updatedAt: true },
    }),
    client.memoryCandidate.aggregate({
      where: { representativeId: actor.representativeId },
      _max: { updatedAt: true },
    }),
    client.memoryUseRun.aggregate({
      where: { representativeId: actor.representativeId },
      _max: { updatedAt: true },
    }),
    client.memoryUseItem.aggregate({
      where: useItemForRepresentative,
      _max: { updatedAt: true },
    }),
    client.memoryProjectionItem.aggregate({
      where: { representativeId: actor.representativeId },
      _max: { updatedAt: true },
    }),
    client.memoryReconciliationRun.aggregate({
      where: { representativeId: actor.representativeId },
      _max: { updatedAt: true },
    }),
    loadPublicKnowledgeProjectionHealth({ client, actor }),
    (options.healthLoader ?? loadMemoryProviderHealth)().catch(() => ({
      status: "degraded" as const,
      reasonCode: "openviking_health_check_failed",
    })),
  ]);
  const effectiveMemoryCount = recallMemoryRows.filter((memory) => (
    evaluateMemoryRecallEligibility({ memory, policy, now }).enabled
  )).length;
  const anomalyCount = projectionAnomalies
    + cleanupAnomalies
    + reconciliationAnomalies
    + publicProjectionHealth.anomalyCount;
  const memoryEnabled = policy?.longTermMemoryEnabled ?? false;
  const serviceStatus = !memoryEnabled
    ? "disabled"
    : health.status === "disabled"
      ? "degraded"
      : health.status;
  const serviceReasonCode = !memoryEnabled
    ? "memory_policy_disabled"
    : health.status === "disabled"
      ? health.reasonCode ?? "openviking_environment_disabled"
      : health.reasonCode;
  const recallKindEnabled = Boolean(
    policy?.contactMemoryEnabled || policy?.representativeExperienceEnabled,
  );
  const extractionKindEnabled = Boolean(
    policy?.contactMemoryEnabled && policy?.autoExtract,
  );
  return {
    representative: {
      id: actor.representativeId,
      slug: actor.representativeSlug,
      displayName: actor.representativeName,
    },
    metrics: {
      effectiveMemories: effectiveMemoryCount,
      pendingCandidates: pendingCandidateCount,
      today: {
        questions: todayQuestions,
        searchHits: todaySearchHits,
        scopePassed: todayScopePassed,
        safetyPassed: todaySafetyPassed,
        injectedIntoModel: todayInjected,
        citedByModel: todayCited,
        displayedSources: todayDisplayed,
        answersUsingMemory,
      },
      anomalies: {
        total: anomalyCount,
        projection: projectionAnomalies,
        cleanup: cleanupAnomalies,
        reconciliation: reconciliationAnomalies,
        publicKnowledge: publicProjectionHealth.anomalyCount,
      },
    },
    service: {
      status: serviceStatus,
      reasonCode: serviceReasonCode,
      enabled: memoryEnabled,
      lastUpdatedAt: maxDate([
        policy?.updatedAt,
        latestMemory._max.updatedAt,
        latestCandidate._max.updatedAt,
        latestUse._max.updatedAt,
        latestUseItem._max.updatedAt,
        latestProjection._max.updatedAt,
        latestReconciliation._max.updatedAt,
        publicProjectionHealth.lastUpdatedAt,
      ]),
      requiresAttention: memoryEnabled
        && (serviceStatus === "degraded" || anomalyCount > 0),
    },
    channels: {
      web: {
        recallSupported: true,
        extractionSupported: true,
        recallEnabled: memoryEnabled && recallKindEnabled
          && Boolean(policy?.webRecallEnabled),
        extractionEnabled: memoryEnabled && extractionKindEnabled
          && Boolean(policy?.webExtractEnabled),
      },
      matrix: {
        recallSupported: false,
        extractionSupported: false,
        recallEnabled: false,
        extractionEnabled: false,
        reasonCode: "memory_channel_disclosure_unavailable",
      },
      telegram: {
        recallSupported: false,
        extractionSupported: false,
        recallEnabled: false,
        extractionEnabled: false,
        reasonCode: "memory_channel_disclosure_unavailable",
      },
    },
    publicKnowledge: {
      managedInKnowledgeLibrary: true,
      activePublishedVersionId: actor.activeVersionId,
      projectionStatus: publicProjectionHealth.projectionStatus,
      syncStatus: publicProjectionHealth.syncStatus,
      syncItemCount: publicProjectionHealth.syncItemCount,
      syncItemCountMatches: publicProjectionHealth.syncItemCountMatches,
      syncErrorCode: publicProjectionHealth.syncErrorCode,
      expectedItemCount: publicProjectionHealth.expectedItemCount,
      projectedItemCount: publicProjectionHealth.projectedItemCount,
      verifiedItemCount: publicProjectionHealth.verifiedItemCount,
      missingItemCount: publicProjectionHealth.missingItemCount,
      mismatchedItemCount: publicProjectionHealth.mismatchedItemCount,
      unexpectedItemCount: publicProjectionHealth.unexpectedItemCount,
      hashTruth: publicProjectionHealth.hashTruth,
      lastProjectedAt:
        publicProjectionHealth.lastProjectedAt?.toISOString() ?? null,
      knowledgeLibraryHref: knowledgeHref(actor.representativeSlug),
    },
    generatedAt: now.toISOString(),
  };
}

const candidateStatuses = new Set<string>(Object.values(MemoryCandidateStatus));
const governedStatuses = new Set<string>(Object.values(GovernedMemoryStatus));

export async function listMemoryDashboardEntries(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    query: unknown;
  },
  options: MemoryDashboardOptions = {},
) {
  const query = memoryEntriesQuerySchema.parse(input.query);
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  const reviewerOnly = actor.role === "REVIEWER";
  if (
    reviewerOnly
    && (
      (query.kind !== undefined && query.kind !== "candidate")
      || (query.status !== undefined && query.status !== MemoryCandidateStatus.PENDING_REVIEW)
    )
  ) {
    throw dashboardForbidden("Reviewers may only view pending memory candidates.");
  }
  const filtersForCursor = {
    kind: reviewerOnly ? "candidate" : query.kind ?? null,
    contactId: query.contactId ?? null,
    scope: query.scope ?? null,
    category: query.category ?? null,
    status: reviewerOnly ? MemoryCandidateStatus.PENDING_REVIEW : query.status ?? null,
    source: query.source ?? null,
    channel: query.channel ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    query: query.query ?? null,
  };
  const page = pageContext(
    "entries",
    actor.representativeId,
    query,
    filtersForCursor,
    now,
  );
  const createdAt = createdAtWindow({
    asOf: page.asOf,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  });
  const normalizedSearch = query.query?.trim();
  const includeCandidates = reviewerOnly || (
    query.kind !== "memory"
    && (!query.status || candidateStatuses.has(query.status))
  );
  const includeMemories = !reviewerOnly
    && query.kind !== "candidate"
    && (!query.status || governedStatuses.has(query.status));
  const [policy, candidates, memories] = await Promise.all([
    reviewerOnly
      ? Promise.resolve(null)
      : client.representativeMemoryPolicy.findUnique({
          where: { representativeId: actor.representativeId },
        }),
    includeCandidates
      ? client.memoryCandidate.findMany({
          where: {
            representativeId: actor.representativeId,
            createdAt,
            ...cursorCreatedAtWhere(page.cursor, "candidate"),
            ...(query.contactId ? { contactId: query.contactId } : {}),
            ...(query.scope ? { scope: query.scope as MemoryScope } : {}),
            ...(query.category
              ? { category: query.category as MemoryCategory }
              : {}),
            ...(reviewerOnly
              ? { status: MemoryCandidateStatus.PENDING_REVIEW }
              : query.status
                ? { status: query.status as MemoryCandidateStatus }
                : {}),
            ...(query.source
              ? { sourceKind: query.source as MemorySourceKind }
              : {}),
            ...(query.channel
              ? { originChannel: query.channel as RepresentativeChannelKind }
              : {}),
            ...(normalizedSearch
              ? {
                  OR: [
                    { id: { contains: normalizedSearch } },
                    { summary: { contains: normalizedSearch, mode: "insensitive" as const } },
                    { safeText: { contains: normalizedSearch, mode: "insensitive" as const } },
                    { sourceConversationId: { contains: normalizedSearch } },
                    { contact: { is: {
                      OR: [
                        { displayName: { contains: normalizedSearch, mode: "insensitive" as const } },
                        { username: { contains: normalizedSearch, mode: "insensitive" as const } },
                      ],
                    } } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: page.limit + 1,
          select: {
            id: true,
            contactId: true,
            scope: true,
            scopeChannel: true,
            originChannel: true,
            category: true,
            sourceKind: true,
            summary: true,
            status: true,
            safetyClass: true,
            safetyReasonCode: true,
            extractionReasonCode: true,
            expiresAt: true,
            createdAt: true,
            updatedAt: true,
            contact: { select: { displayName: true, username: true } },
          },
        })
      : Promise.resolve([]),
    includeMemories
      ? client.governedMemory.findMany({
          where: {
            representativeId: actor.representativeId,
            createdAt,
            ...cursorCreatedAtWhere(page.cursor, "memory"),
            ...(query.contactId ? { contactId: query.contactId } : {}),
            ...(query.scope ? { scope: query.scope as MemoryScope } : {}),
            ...(query.category
              ? { category: query.category as MemoryCategory }
              : {}),
            ...(query.status
              ? { status: query.status as GovernedMemoryStatus }
              : {}),
            ...(query.source
              ? {
                  currentVersion: {
                    is: {
                      sourceCandidate: {
                        is: { sourceKind: query.source as MemorySourceKind },
                      },
                    },
                  },
                }
              : {}),
            ...(query.channel
              ? { sourceChannel: query.channel as RepresentativeChannelKind }
              : {}),
            ...(normalizedSearch
              ? {
                  OR: [
                    { id: { contains: normalizedSearch } },
                    { currentVersion: { is: {
                      OR: [
                        { summary: { contains: normalizedSearch, mode: "insensitive" as const } },
                        { safeText: { contains: normalizedSearch, mode: "insensitive" as const } },
                      ],
                    } } },
                    { contact: { is: {
                      OR: [
                        { displayName: { contains: normalizedSearch, mode: "insensitive" as const } },
                        { username: { contains: normalizedSearch, mode: "insensitive" as const } },
                      ],
                    } } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: page.limit + 1,
          select: {
            ...memoryRecallSelect,
            createdAt: true,
            updatedAt: true,
            contact: { select: { displayName: true, username: true } },
            currentVersion: {
              select: {
                ...memoryRecallVersionSelect,
                useItems: {
                  where: { injectedAt: { not: null } },
                  orderBy: [{ injectedAt: "desc" }, { id: "desc" }],
                  take: 1,
                  select: { injectedAt: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const rows = [
    ...candidates.map((candidate) => ({
      id: candidate.id,
      kind: "candidate" as const,
      sortAt: candidate.createdAt.toISOString(),
      scope: candidate.scope,
      category: candidate.category,
      status: candidate.status,
      contact: candidate.contactId
        ? { id: candidate.contactId, label: contactLabel(candidate.contact) }
        : null,
      sourceChannel: candidate.scopeChannel ?? candidate.originChannel,
      sourceKind: candidate.sourceKind,
      summary: candidate.summary,
      safety: {
        classification: candidate.safetyClass,
        reasonCode: candidate.safetyReasonCode,
      },
      extractionReasonCode: candidate.extractionReasonCode,
      expiresAt: candidate.expiresAt?.toISOString() ?? null,
      lastUsedAt: null,
      createdAt: candidate.createdAt.toISOString(),
      updatedAt: candidate.updatedAt.toISOString(),
    })),
    ...memories.map((memory) => {
      const recallEligibility = evaluateMemoryRecallEligibility({
        memory,
        policy,
        now,
      });
      return {
      id: memory.id,
      kind: "memory" as const,
      sortAt: memory.createdAt.toISOString(),
      scope: memory.scope,
      category: memory.category,
      status: memory.status,
      contact: memory.contactId
        ? { id: memory.contactId, label: contactLabel(memory.contact) }
        : null,
      sourceChannel: memory.sourceChannel,
      sourceKind: memory.currentVersion?.sourceCandidate?.sourceKind ?? null,
      summary: memory.currentVersion?.purgedAt
        ? null
        : memory.currentVersion?.summary ?? null,
      recallEnabled: recallEligibility.enabled,
      recallEligibility,
      expiresAt: memory.expiresAt?.toISOString() ?? null,
      lastUsedAt:
        memory.currentVersion?.useItems[0]?.injectedAt?.toISOString() ?? null,
      currentVersionId: memory.currentVersion?.id ?? null,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
      };
    }),
  ];
  const resultPage = buildPage("entries", rows, page);
  const detail = query.entryId
    ? await getMemoryEntryDetail({
        client,
        actor,
        entryId: query.entryId,
        preferredKind: reviewerOnly ? "candidate" : query.kind,
        policy,
        now,
      })
    : null;
  return {
    representative: {
      id: actor.representativeId,
      slug: actor.representativeSlug,
      displayName: actor.representativeName,
    },
    page: {
      asOf: resultPage.asOf,
      limit: resultPage.limit,
      hasMore: resultPage.hasMore,
      nextCursor: resultPage.nextCursor,
    },
    items: resultPage.items.map(({ sortAt: _sortAt, ...item }) => item),
    detail,
  };
}

async function getMemoryEntryDetail(input: {
  client: MemoryDashboardClient;
  actor: MemoryDashboardActor;
  entryId: string;
  preferredKind?: "candidate" | "memory" | undefined;
  policy: RecallPolicy | null;
  now: Date;
}) {
  if (input.preferredKind !== "memory") {
    const candidate = await input.client.memoryCandidate.findFirst({
      where: {
        id: input.entryId,
        representativeId: input.actor.representativeId,
        ...(input.actor.role === "REVIEWER"
          ? { status: MemoryCandidateStatus.PENDING_REVIEW }
          : {}),
      },
      select: {
        id: true,
        contactId: true,
        scope: true,
        scopeChannel: true,
        originChannel: true,
        category: true,
        sourceKind: true,
        safeText: true,
        summary: true,
        contentPurgedAt: true,
        status: true,
        safetyClass: true,
        safetyReasonCode: true,
        extractionReasonCode: true,
        sourceConversationId: true,
        sourceMessageId: true,
        correctionMemoryId: true,
        correctionBaseVersionId: true,
        deidentifiedAt: true,
        expiresAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
        contact: { select: { displayName: true, username: true } },
        reviewDecisions: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            outcome: true,
            reviewerRole: true,
            reasonCode: true,
            createdAt: true,
          },
        },
      },
    });
    if (candidate) {
      return {
        id: candidate.id,
        kind: "candidate" as const,
        scope: candidate.scope,
        category: candidate.category,
        status: candidate.status,
        contact: candidate.contactId
          ? { id: candidate.contactId, label: contactLabel(candidate.contact) }
          : null,
        sourceChannel: candidate.scopeChannel ?? candidate.originChannel,
        sourceKind: candidate.sourceKind,
        safeText: candidate.contentPurgedAt ? null : candidate.safeText,
        summary: candidate.contentPurgedAt ? null : candidate.summary,
        extraction: {
          reasonCode: candidate.extractionReasonCode,
          deidentifiedAt: candidate.deidentifiedAt?.toISOString() ?? null,
        },
        safety: {
          classification: candidate.safetyClass,
          reasonCode: candidate.safetyReasonCode,
        },
        provenance: {
          conversationId: candidate.sourceConversationId,
          messageId: candidate.sourceMessageId,
          inboxHref: inboxHref({
            representativeSlug: input.actor.representativeSlug,
            conversationId: candidate.sourceConversationId,
            messageId: candidate.sourceMessageId,
          }),
        },
        correction: candidate.correctionMemoryId
          ? {
              memoryId: candidate.correctionMemoryId,
              baseVersionId: candidate.correctionBaseVersionId,
            }
          : null,
        reviews: candidate.reviewDecisions.map((decision) => ({
          id: decision.id,
          outcome: decision.outcome,
          reviewerRole: decision.reviewerRole,
          reasonCode: decision.reasonCode,
          createdAt: decision.createdAt.toISOString(),
        })),
        expiresAt: candidate.expiresAt?.toISOString() ?? null,
        reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
        createdAt: candidate.createdAt.toISOString(),
        updatedAt: candidate.updatedAt.toISOString(),
      };
    }
  }

  if (input.preferredKind !== "candidate") {
    const memory = await input.client.governedMemory.findFirst({
      where: {
        id: input.entryId,
        representativeId: input.actor.representativeId,
      },
      select: {
        ...memoryRecallSelect,
        suppressedAt: true,
        supersededAt: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        contact: { select: { displayName: true, username: true } },
        currentVersion: {
          select: {
            ...memoryRecallVersionSelect,
            versionNumber: true,
            correctionReasonCode: true,
            createdAt: true,
            sourceCandidate: {
              select: {
                representativeId: true,
                contactId: true,
                scope: true,
                scopeChannel: true,
                sourceKind: true,
                status: true,
                contentPurgedAt: true,
                extractionReasonCode: true,
                safetyClass: true,
                safetyReasonCode: true,
                sourceConversationId: true,
                sourceMessageId: true,
                deidentifiedAt: true,
              },
            },
            useItems: {
              where: { injectedAt: { not: null } },
              orderBy: [{ injectedAt: "desc" }, { id: "desc" }],
              take: 10,
              select: {
                id: true,
                searchedAt: true,
                injectedAt: true,
                citedAt: true,
                displayedAt: true,
                useRun: {
                  select: {
                    conversationId: true,
                    inputMessageId: true,
                  },
                },
              },
            },
          },
        },
        reviewDecisions: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            outcome: true,
            reviewerRole: true,
            reasonCode: true,
            resultVersionId: true,
            createdAt: true,
          },
        },
        deletionProof: {
          select: {
            id: true,
            cleanupStatus: true,
            recallBlockedAt: true,
            completedAt: true,
            attemptCount: true,
            lastErrorCode: true,
            updatedAt: true,
          },
        },
      },
    });
    if (memory) {
      const version = memory.currentVersion;
      const source = version?.sourceCandidate;
      const recallEligibility = evaluateMemoryRecallEligibility({
        memory,
        policy: input.policy,
        now: input.now,
      });
      return {
        id: memory.id,
        kind: "memory" as const,
        scope: memory.scope,
        category: memory.category,
        status: memory.status,
        contact: memory.contactId
          ? { id: memory.contactId, label: contactLabel(memory.contact) }
          : null,
        sourceChannel: memory.sourceChannel,
        recallEnabled: recallEligibility.enabled,
        recallEligibility,
        version: version
          ? {
              id: version.id,
              number: version.versionNumber,
              safeText: version.purgedAt ? null : version.safeText,
              summary: version.purgedAt ? null : version.summary,
              correctionReasonCode: version.correctionReasonCode,
              createdAt: version.createdAt.toISOString(),
            }
          : null,
        extraction: source
          ? {
              sourceKind: source.sourceKind,
              reasonCode: source.extractionReasonCode,
              deidentifiedAt: source.deidentifiedAt?.toISOString() ?? null,
            }
          : null,
        safety: source
          ? {
              classification: source.safetyClass,
              reasonCode: source.safetyReasonCode,
            }
          : null,
        provenance: source
          ? {
              conversationId: source.sourceConversationId,
              messageId: source.sourceMessageId,
              inboxHref: inboxHref({
                representativeSlug: input.actor.representativeSlug,
                conversationId: source.sourceConversationId,
                messageId: source.sourceMessageId,
              }),
            }
          : null,
        reviews: memory.reviewDecisions.map((decision) => ({
          id: decision.id,
          outcome: decision.outcome,
          reviewerRole: decision.reviewerRole,
          reasonCode: decision.reasonCode,
          resultVersionId: decision.resultVersionId,
          createdAt: decision.createdAt.toISOString(),
        })),
        recentUse: (version?.useItems ?? []).map((item) => ({
          id: item.id,
          searchedAt: item.searchedAt?.toISOString() ?? null,
          injectedAt: item.injectedAt?.toISOString() ?? null,
          citedAt: item.citedAt?.toISOString() ?? null,
          displayedAt: item.displayedAt?.toISOString() ?? null,
          inboxHref: inboxHref({
            representativeSlug: input.actor.representativeSlug,
            conversationId: item.useRun.conversationId,
            messageId: item.useRun.inputMessageId,
          }),
        })),
        lifecycle: {
          expiresAt: memory.expiresAt?.toISOString() ?? null,
          suppressedAt: memory.suppressedAt?.toISOString() ?? null,
          supersededAt: memory.supersededAt?.toISOString() ?? null,
          archivedAt: memory.archivedAt?.toISOString() ?? null,
          deleteRequestedAt: memory.deleteRequestedAt?.toISOString() ?? null,
          deletedAt: memory.deletedAt?.toISOString() ?? null,
        },
        cleanup: memory.deletionProof
          ? {
              id: memory.deletionProof.id,
              status: memory.deletionProof.cleanupStatus,
              recallBlockedAt:
                memory.deletionProof.recallBlockedAt.toISOString(),
              completedAt:
                memory.deletionProof.completedAt?.toISOString() ?? null,
              attemptCount: memory.deletionProof.attemptCount,
              errorCode: memory.deletionProof.lastErrorCode,
              updatedAt: memory.deletionProof.updatedAt.toISOString(),
            }
          : null,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
      };
    }
  }
  throw dashboardNotFound();
}

export async function listMemoryDashboardUsage(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    query: unknown;
  },
  options: MemoryDashboardOptions = {},
) {
  const query = memoryUsageQuerySchema.parse(input.query);
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertFullMemoryDashboardActor(actor);
  const filtersForCursor = {
    contactId: query.contactId ?? null,
    conversationId: query.conversationId ?? null,
    messageId: query.messageId ?? null,
    channel: query.channel ?? null,
    status: query.status ?? null,
    sourceKind: query.sourceKind ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };
  const page = pageContext(
    "usage",
    actor.representativeId,
    query,
    filtersForCursor,
    now,
  );
  const runs = await client.memoryUseRun.findMany({
    where: {
      representativeId: actor.representativeId,
      createdAt: createdAtWindow({
        asOf: page.asOf,
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      }),
      ...cursorCreatedAtWhere(page.cursor, "usage"),
      ...(query.contactId ? { contactId: query.contactId } : {}),
      ...(query.conversationId
        ? { conversationId: query.conversationId }
        : {}),
      ...(query.messageId
        ? {
            OR: [
              { inputMessageId: query.messageId },
              { outputMessageId: query.messageId },
            ],
          }
        : {}),
      ...(query.channel
        ? { sourceChannel: query.channel as RepresentativeChannelKind }
        : {}),
      ...(query.status
        ? { status: query.status as MemoryUseRunStatus }
        : {}),
      ...(query.sourceKind
        ? {
            items: {
              some: {
                sourceKind: query.sourceKind as MemoryUseSourceKind,
              },
            },
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    select: {
      id: true,
      conversationId: true,
      contactId: true,
      sourceChannel: true,
      representativeVersionId: true,
      inputMessageId: true,
      outputMessageId: true,
      status: true,
      reasonCode: true,
      unmappedCandidateCount: true,
      searchedCount: true,
      scopePassedCount: true,
      safetyPassedCount: true,
      injectedCount: true,
      citedCount: true,
      displayedCount: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      contact: { select: { displayName: true, username: true } },
      items: {
        orderBy: [{ searchRank: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          sourceKind: true,
          searchedAt: true,
          scopeCheckedAt: true,
          scopePassedAt: true,
          safetyCheckedAt: true,
          safetyPassedAt: true,
          injectedAt: true,
          citedAt: true,
          displayedAt: true,
          rejectionReasonCode: true,
          memoryVersion: {
            select: {
              summary: true,
              purgedAt: true,
              memory: { select: { id: true, category: true, scope: true } },
            },
          },
          publicKnowledgeProjection: {
            select: {
              sourceKind: true,
              knowledgeAssetId: true,
            },
          },
          citation: { select: { title: true } },
        },
      },
    },
  });
  const rows = runs.map((run) => ({
    id: run.id,
    kind: "usage" as const,
    sortAt: run.createdAt.toISOString(),
    status: run.status,
    reasonCode: run.reasonCode,
    contact: {
      id: run.contactId,
      label: contactLabel(run.contact),
    },
    sourceChannel: run.sourceChannel,
    representativeVersionId: run.representativeVersionId,
    trigger: {
      conversationId: run.conversationId,
      messageId: run.inputMessageId,
      inboxHref: inboxHref({
        representativeSlug: actor.representativeSlug,
        conversationId: run.conversationId,
        messageId: run.inputMessageId,
      }),
    },
    outputMessageId: run.outputMessageId,
    counts: {
      searchHits: run.searchedCount,
      scopePassed: run.scopePassedCount,
      safetyPassed: run.safetyPassedCount,
      injectedIntoModel: run.injectedCount,
      citedByModel: run.citedCount,
      displayedSources: run.displayedCount,
      unmappedProviderCandidates: run.unmappedCandidateCount,
    },
    sources: run.items.map((item) => ({
      id: item.id,
      sourceKind: item.sourceKind,
      title: item.citation?.title
        ?? (item.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE
          ? "公开知识"
          : item.sourceKind === MemoryUseSourceKind.CONTACT_MEMORY
            ? (!item.memoryVersion?.purgedAt
              ? item.memoryVersion?.summary ?? "本人历史信息"
              : "本人历史信息")
            : (!item.memoryVersion?.purgedAt
              ? item.memoryVersion?.summary ?? "已审核代表经验"
              : "已审核代表经验")),
      entry: item.memoryVersion?.memory
        ? {
            id: item.memoryVersion.memory.id,
            scope: item.memoryVersion.memory.scope,
            category: item.memoryVersion.memory.category,
          }
        : null,
      publicKnowledge: item.publicKnowledgeProjection
        ? {
            sourceKind: item.publicKnowledgeProjection.sourceKind,
            knowledgeAssetId:
              item.publicKnowledgeProjection.knowledgeAssetId,
            knowledgeLibraryHref: knowledgeHref(actor.representativeSlug),
          }
        : null,
      stages: {
        searchedAt: item.searchedAt?.toISOString() ?? null,
        scopeCheckedAt: item.scopeCheckedAt?.toISOString() ?? null,
        scopePassedAt: item.scopePassedAt?.toISOString() ?? null,
        safetyCheckedAt: item.safetyCheckedAt?.toISOString() ?? null,
        safetyPassedAt: item.safetyPassedAt?.toISOString() ?? null,
        injectedAt: item.injectedAt?.toISOString() ?? null,
        citedAt: item.citedAt?.toISOString() ?? null,
        displayedAt: item.displayedAt?.toISOString() ?? null,
      },
      rejectionReasonCode: item.rejectionReasonCode,
    })),
    displayedSources: run.items
      .filter((item) => item.displayedAt !== null)
      .map((item) => ({
        id: item.id,
        title: item.citation?.title
          ?? (item.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE
            ? "公开知识"
            : item.sourceKind === MemoryUseSourceKind.CONTACT_MEMORY
              ? "本人历史信息"
              : "已审核代表经验"),
        sourceKind: item.sourceKind,
      })),
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  }));
  const resultPage = buildPage("usage", rows, page);
  return {
    representative: {
      id: actor.representativeId,
      slug: actor.representativeSlug,
      displayName: actor.representativeName,
    },
    page: {
      asOf: resultPage.asOf,
      limit: resultPage.limit,
      hasMore: resultPage.hasMore,
      nextCursor: resultPage.nextCursor,
    },
    items: resultPage.items.map(({ sortAt: _sortAt, kind: _kind, ...item }) => item),
  };
}

const extractionStatuses = new Set<string>(Object.values(MemoryExtractionStatus));
const projectionStatuses = new Set<string>(Object.values(MemoryProjectionStatus));
const cleanupStatuses = new Set<string>(Object.values(MemoryCleanupStatus));
const publicKnowledgeSyncStatuses = new Set([
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "disabled",
  "blocked_unpublished",
  "blocked_missing_credentials",
]);
const publicKnowledgeSyncTriggers = new Set([
  "manual",
  "create",
  "setup_update",
  "publish",
  "activate",
  "retry",
]);

export async function listMemoryDashboardOperations(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    query: unknown;
  },
  options: MemoryDashboardOptions = {},
) {
  const query = memoryOperationsQuerySchema.parse(input.query);
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertFullMemoryDashboardActor(actor);
  const filtersForCursor = {
    kind: query.kind ?? null,
    status: query.status ?? null,
    channel: query.channel ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };
  const page = pageContext(
    "operations",
    actor.representativeId,
    query,
    filtersForCursor,
    now,
  );
  const createdAt = createdAtWindow({
    asOf: page.asOf,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  });
  const includeExtraction = (!query.kind || query.kind === "extraction")
    && (!query.status || extractionStatuses.has(query.status));
  const includeProjection = (!query.kind || query.kind === "projection")
    && (!query.status || projectionStatuses.has(query.status));
  const includeCleanup = (!query.kind || query.kind === "cleanup")
    && !query.channel
    && (!query.status || cleanupStatuses.has(query.status));
  const includePublicKnowledgeSync = (
    !query.kind || query.kind === "public_knowledge_sync"
  )
    && !query.channel
    && (!query.status || publicKnowledgeSyncStatuses.has(query.status));
  const [extractions, projections, cleanups, publicKnowledgeSyncs] = await Promise.all([
    includeExtraction
      ? client.memoryExtractionRun.findMany({
          where: {
            representativeId: actor.representativeId,
            createdAt,
            ...cursorCreatedAtWhere(page.cursor, "extraction"),
            ...(query.status
              ? { status: query.status as MemoryExtractionStatus }
              : {}),
            ...(query.channel
              ? { sourceChannel: query.channel as RepresentativeChannelKind }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: page.limit + 1,
          select: {
            id: true,
            contactId: true,
            sourceChannel: true,
            sourceConversationId: true,
            sourceMessageId: true,
            trigger: true,
            status: true,
            candidateCount: true,
            acceptedCount: true,
            rejectedCount: true,
            quarantinedCount: true,
            reasonCounts: true,
            attemptCount: true,
            startedAt: true,
            finishedAt: true,
            errorCode: true,
            createdAt: true,
            updatedAt: true,
            contact: { select: { displayName: true, username: true } },
          },
        })
      : Promise.resolve([]),
    includeProjection
      ? client.memoryProjectionItem.findMany({
          where: {
            representativeId: actor.representativeId,
            createdAt,
            ...cursorCreatedAtWhere(page.cursor, "projection"),
            ...(query.status
              ? { status: query.status as MemoryProjectionStatus }
              : {}),
            ...(query.channel
              ? {
                  memoryVersion: {
                    is: {
                      memory: {
                        is: {
                          sourceChannel:
                            query.channel as RepresentativeChannelKind,
                        },
                      },
                    },
                  },
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: page.limit + 1,
          select: {
            id: true,
            memoryId: true,
            memoryVersionId: true,
            lane: true,
            status: true,
            attemptCount: true,
            projectedAt: true,
            deleteRequestedAt: true,
            deletedAt: true,
            lastErrorCode: true,
            createdAt: true,
            updatedAt: true,
            memoryVersion: {
              select: {
                summary: true,
                purgedAt: true,
                memory: {
                  select: {
                    scope: true,
                    category: true,
                    sourceChannel: true,
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    includeCleanup
      ? client.memoryDeletionProof.findMany({
          where: {
            representativeId: actor.representativeId,
            createdAt,
            ...cursorCreatedAtWhere(page.cursor, "cleanup"),
            ...(query.status
              ? { cleanupStatus: query.status as MemoryCleanupStatus }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: page.limit + 1,
          select: {
            id: true,
            memoryId: true,
            reasonCode: true,
            recallBlockedAt: true,
            localPurgeCompletedAt: true,
            remotePurgeCompletedAt: true,
            completedAt: true,
            cleanupStatus: true,
            attemptCount: true,
            lastErrorCode: true,
            createdAt: true,
            updatedAt: true,
            memory: { select: { scope: true, category: true } },
          },
        })
      : Promise.resolve([]),
    includePublicKnowledgeSync
      ? client.representativeContextSync.findMany({
          where: {
            representativeId: actor.representativeId,
            createdAt,
            ...cursorCreatedAtWhere(page.cursor, "public_knowledge_sync"),
            ...(query.status ? { status: query.status } : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: page.limit + 1,
          select: {
            id: true,
            requestedVersionId: true,
            trigger: true,
            status: true,
            itemCount: true,
            attemptCount: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const rows = [
    ...extractions.map((run) => ({
      id: run.id,
      kind: "extraction" as const,
      sortAt: run.createdAt.toISOString(),
      status: run.status,
      trigger: run.trigger,
      sourceChannel: run.sourceChannel,
      contact: run.contactId
        ? { id: run.contactId, label: contactLabel(run.contact) }
        : null,
      provenance: run.sourceConversationId
        ? {
            conversationId: run.sourceConversationId,
            messageId: run.sourceMessageId,
            inboxHref: inboxHref({
              representativeSlug: actor.representativeSlug,
              conversationId: run.sourceConversationId,
              messageId: run.sourceMessageId,
            }),
          }
        : null,
      counts: {
        candidates: run.candidateCount,
        accepted: run.acceptedCount,
        rejected: run.rejectedCount,
        quarantined: run.quarantinedCount,
      },
      reasons: safeReasonCounts(run.reasonCounts),
      retry: {
        supported: run.sourceChannel === RepresentativeChannelKind.WEB,
        available: run.status === MemoryExtractionStatus.FAILED
          && run.sourceChannel === RepresentativeChannelKind.WEB,
        reasonCode: run.sourceChannel === RepresentativeChannelKind.WEB
          ? run.status === MemoryExtractionStatus.FAILED
            ? null
            : "memory_extraction_not_failed"
          : "memory_channel_disclosure_unavailable",
      },
      attemptCount: run.attemptCount,
      errorCode: run.errorCode,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    })),
    ...projections.map((projection) => ({
      id: projection.id,
      kind: "projection" as const,
      sortAt: projection.createdAt.toISOString(),
      status: projection.status,
      environment: projection.lane === "STAGING" ? "staging" : "recall",
      memory: {
        id: projection.memoryId,
        versionId: projection.memoryVersionId,
        scope: projection.memoryVersion.memory.scope,
        category: projection.memoryVersion.memory.category,
        sourceChannel: projection.memoryVersion.memory.sourceChannel,
        summary: projection.memoryVersion.purgedAt
          ? null
          : projection.memoryVersion.summary,
      },
      attemptCount: projection.attemptCount,
      retry: {
        supported: projection.lane === MemoryProjectionLane.RECALL,
        available: projection.status === MemoryProjectionStatus.FAILED
          && projection.lane === MemoryProjectionLane.RECALL,
        reasonCode: projection.lane !== MemoryProjectionLane.RECALL
          ? "memory_projection_environment_not_recall"
          : projection.status === MemoryProjectionStatus.FAILED
            ? null
            : "memory_projection_not_failed",
      },
      errorCode: projection.lastErrorCode,
      projectedAt: projection.projectedAt?.toISOString() ?? null,
      deleteRequestedAt:
        projection.deleteRequestedAt?.toISOString() ?? null,
      deletedAt: projection.deletedAt?.toISOString() ?? null,
      createdAt: projection.createdAt.toISOString(),
      updatedAt: projection.updatedAt.toISOString(),
    })),
    ...cleanups.map((cleanup) => ({
      id: cleanup.id,
      kind: "cleanup" as const,
      sortAt: cleanup.createdAt.toISOString(),
      status: cleanup.cleanupStatus,
      memory: {
        id: cleanup.memoryId,
        scope: cleanup.memory.scope,
        category: cleanup.memory.category,
      },
      reasonCode: cleanup.reasonCode,
      recallBlockedAt: cleanup.recallBlockedAt.toISOString(),
      localPurgeCompletedAt:
        cleanup.localPurgeCompletedAt?.toISOString() ?? null,
      remotePurgeCompletedAt:
        cleanup.remotePurgeCompletedAt?.toISOString() ?? null,
      completedAt: cleanup.completedAt?.toISOString() ?? null,
      attemptCount: cleanup.attemptCount,
      errorCode: cleanup.lastErrorCode,
      createdAt: cleanup.createdAt.toISOString(),
      updatedAt: cleanup.updatedAt.toISOString(),
    })),
    ...publicKnowledgeSyncs.map((sync) => ({
      id: sync.id,
      kind: "public_knowledge_sync" as const,
      sortAt: sync.createdAt.toISOString(),
      status: publicKnowledgeSyncStatuses.has(sync.status)
        ? sync.status
        : "unknown",
      trigger: sync.trigger && publicKnowledgeSyncTriggers.has(sync.trigger)
        ? sync.trigger
        : "unknown",
      publishedVersionId: sync.requestedVersionId,
      verifiedItemCount: sync.itemCount,
      partialSuccess: sync.itemCount > 0
        && (sync.status === "retry_wait" || sync.status === "failed"),
      attemptCount: sync.attemptCount,
      errorCode: new Set([
        "retry_wait",
        "failed",
        "disabled",
        "blocked_unpublished",
        "blocked_missing_credentials",
      ]).has(sync.status)
        ? `public_knowledge_sync_${sync.status}`
        : publicKnowledgeSyncStatuses.has(sync.status)
          ? null
          : "public_knowledge_sync_unknown_status",
      knowledgeLibraryHref: knowledgeHref(actor.representativeSlug),
      startedAt: sync.startedAt.toISOString(),
      finishedAt: sync.finishedAt?.toISOString() ?? null,
      createdAt: sync.createdAt.toISOString(),
      updatedAt: sync.updatedAt.toISOString(),
    })),
  ];
  const resultPage = buildPage("operations", rows, page);
  return {
    representative: {
      id: actor.representativeId,
      slug: actor.representativeSlug,
      displayName: actor.representativeName,
    },
    page: {
      asOf: resultPage.asOf,
      limit: resultPage.limit,
      hasMore: resultPage.hasMore,
      nextCursor: resultPage.nextCursor,
    },
    items: resultPage.items.map(({ sortAt: _sortAt, ...item }) => item),
  };
}

export async function listMemoryDashboardReconciliation(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    query: unknown;
  },
  options: MemoryDashboardOptions = {},
) {
  const query = memoryReconciliationQuerySchema.parse(input.query);
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();
  const actor = await resolveMemoryDashboardActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertFullMemoryDashboardActor(actor);
  const filtersForCursor = {
    status: query.status ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };
  const page = pageContext(
    "reconciliation",
    actor.representativeId,
    query,
    filtersForCursor,
    now,
  );
  const runs = await client.memoryReconciliationRun.findMany({
    where: {
      representativeId: actor.representativeId,
      createdAt: createdAtWindow({
        asOf: page.asOf,
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      }),
      ...cursorCreatedAtWhere(page.cursor, "reconciliation"),
      ...(query.status
        ? { status: query.status as MemoryReconciliationStatus }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    select: {
      id: true,
      provider: true,
      status: true,
      asOf: true,
      expectedCount: true,
      observedCount: true,
      matchedCount: true,
      issueCount: true,
      resolvedCount: true,
      attemptCount: true,
      startedAt: true,
      finishedAt: true,
      errorCode: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const rows = runs.map((run) => ({
    id: run.id,
    kind: "reconciliation" as const,
    sortAt: run.createdAt.toISOString(),
    provider: run.provider,
    status: run.status,
    inventoryStatus: "partial" as const,
    exactKnownProjectionChecks: "supported" as const,
    remoteEnumeration: "unsupported" as const,
    inventoryReasonCode: "openviking_inventory_no_snapshot_cursor" as const,
    coverage: {
      expected: run.expectedCount,
      observed: run.observedCount,
      matched: run.matchedCount,
      issues: run.issueCount,
      resolved: run.resolvedCount,
    },
    attemptCount: run.attemptCount,
    errorCode: run.errorCode,
    anchoredAt: run.asOf.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  }));
  const resultPage = buildPage("reconciliation", rows, page);
  const detail = query.runId
    ? await getMemoryReconciliationDetail({
        client,
        actor,
        runId: query.runId,
        itemCursor: query.itemCursor,
        itemLimit: query.itemLimit ?? 50,
        asOf: page.asOf,
      })
    : null;
  return {
    representative: {
      id: actor.representativeId,
      slug: actor.representativeSlug,
      displayName: actor.representativeName,
    },
    inventoryCapability: {
      inventoryStatus: "partial" as const,
      exactKnownProjectionChecks: "supported" as const,
      remoteEnumeration: "unsupported" as const,
      reasonCode: "openviking_inventory_no_snapshot_cursor" as const,
      automaticUnknownObjectDeletion: false,
    },
    page: {
      asOf: resultPage.asOf,
      limit: resultPage.limit,
      hasMore: resultPage.hasMore,
      nextCursor: resultPage.nextCursor,
    },
    items: resultPage.items.map(({ sortAt: _sortAt, kind: _kind, ...item }) => item),
    detail,
  };
}

async function getMemoryReconciliationDetail(input: {
  client: MemoryDashboardClient;
  actor: MemoryDashboardActor;
  runId: string;
  itemCursor?: string | undefined;
  itemLimit: number;
  asOf: Date;
}) {
  const issueScope = stableScope({
    representativeId: input.actor.representativeId,
    runId: input.runId,
  });
  const issueCursor = decodeReconciliationIssueCursor(
    input.itemCursor,
    issueScope,
  );
  const issueAsOf = issueCursor?.asOf ?? input.asOf;
  const run = await input.client.memoryReconciliationRun.findFirst({
    where: {
      id: input.runId,
      representativeId: input.actor.representativeId,
    },
    select: {
      id: true,
      provider: true,
      status: true,
      asOf: true,
      expectedCount: true,
      observedCount: true,
      matchedCount: true,
      issueCount: true,
      resolvedCount: true,
      attemptCount: true,
      startedAt: true,
      finishedAt: true,
      errorCode: true,
      createdAt: true,
      updatedAt: true,
      items: {
        where: {
          createdAt: { lte: issueAsOf },
          ...(issueCursor
            ? {
                OR: [
                  { createdAt: { gt: issueCursor.createdAt, lte: issueAsOf } },
                  {
                    createdAt: issueCursor.createdAt,
                    id: { gt: issueCursor.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: input.itemLimit + 1,
        select: {
          id: true,
          issueKind: true,
          status: true,
          reasonCode: true,
          attemptCount: true,
          resolvedAt: true,
          lastErrorCode: true,
          createdAt: true,
          updatedAt: true,
          projectionItem: {
            select: {
              id: true,
              memoryId: true,
              memoryVersionId: true,
              lane: true,
              status: true,
            },
          },
        },
      },
    },
  });
  if (!run) throw dashboardNotFound();
  const hasMoreIssues = run.items.length > input.itemLimit;
  const issues = run.items.slice(0, input.itemLimit);
  const lastIssue = issues.at(-1);
  return {
    id: run.id,
    provider: run.provider,
    status: run.status,
    inventoryStatus: "partial" as const,
    exactKnownProjectionChecks: "supported" as const,
    remoteEnumeration: "unsupported" as const,
    inventoryReasonCode: "openviking_inventory_no_snapshot_cursor" as const,
    coverage: {
      expected: run.expectedCount,
      observed: run.observedCount,
      matched: run.matchedCount,
      issues: run.issueCount,
      resolved: run.resolvedCount,
    },
    issuesPage: {
      asOf: issueAsOf.toISOString(),
      limit: input.itemLimit,
      hasMore: hasMoreIssues,
      nextCursor: hasMoreIssues && lastIssue
        ? encodeReconciliationIssueCursor({
            asOf: issueAsOf,
            createdAt: lastIssue.createdAt,
            id: lastIssue.id,
            scope: issueScope,
          })
        : null,
    },
    issues: issues.map((item) => ({
      id: item.id,
      issueKind: item.issueKind,
      status: item.status,
      reasonCode: item.reasonCode,
      attemptCount: item.attemptCount,
      errorCode: item.lastErrorCode,
      projection: item.projectionItem
        ? {
            id: item.projectionItem.id,
            memoryId: item.projectionItem.memoryId,
            memoryVersionId: item.projectionItem.memoryVersionId,
            environment:
              item.projectionItem.lane === "STAGING" ? "staging" : "recall",
            status: item.projectionItem.status,
          }
        : null,
      resolvedAt: item.resolvedAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    attemptCount: run.attemptCount,
    errorCode: run.errorCode,
    anchoredAt: run.asOf.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
