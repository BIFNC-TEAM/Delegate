import { EventType, Prisma } from "@prisma/client";
import { demoRepresentative } from "@delegate/domain";

import { prisma } from "./prisma";

export type WorkspaceAuditCategory =
  | "skills"
  | "publishing"
  | "approvals"
  | "wallet"
  | "tools"
  | "workflow"
  | "conversation"
  | "settings"
  | "security"
  | "other";

export type WorkspaceAuditEvent = {
  id: string;
  type: string;
  category: WorkspaceAuditCategory;
  representativeSlug: string | null;
  representativeName: string | null;
  actor: string | null;
  summary: string;
  resource: { kind: string; id: string } | null;
  traceId: string | null;
  anomaly: boolean;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
};

export type WorkspaceAuditSnapshot = {
  workspace: { ownerId: string; representativeCount: number };
  metrics: { total: number; last24Hours: number; decisions: number; anomalies: number };
  categories: Array<{ id: WorkspaceAuditCategory; count: number }>;
  page: {
    filteredTotal: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  events: WorkspaceAuditEvent[];
};

export type WorkspaceAuditExport = {
  filteredTotal: number;
  events: AsyncIterable<WorkspaceAuditEvent>;
};

export class WorkspaceAuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAuditInputError";
  }
}

type WorkspaceAuditQueryInput = {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  category?: WorkspaceAuditCategory | "all";
  query?: string;
};

type WorkspaceAuditRecord = {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  representative: { slug: string; displayName: string } | null;
};

type WorkspaceAuditCursor = {
  createdAt: Date;
  id: string;
};

const defaultPageSize = 50;
const maximumPageSize = 200;
const exportPageSize = 500;
const maximumQueryLength = 200;

export const workspaceAuditCategories: readonly WorkspaceAuditCategory[] = [
  "skills",
  "publishing",
  "approvals",
  "wallet",
  "tools",
  "workflow",
  "conversation",
  "settings",
  "security",
  "other",
];

const allEventTypes = Object.values(EventType);
const eventTypesByCategory = Object.fromEntries(
  workspaceAuditCategories.map((category) => [
    category,
    allEventTypes.filter((type) => classifyWorkspaceAuditEvent(type) === category),
  ]),
) as Record<WorkspaceAuditCategory, EventType[]>;
const anomalyTypeTokens = ["failed", "blocked", "invalid", "expired"];
const anomalyEventTypes = allEventTypes.filter((type) =>
  anomalyTypeTokens.some((token) => type.toLowerCase().includes(token))
);
const anomalyPayloadValues = ["failed", "blocked", "invalid", "expired"];
const searchablePayloadKeys = [
  "slug",
  "skillSlug",
  "representativeSlug",
  "version",
  "installedVersion",
  "status",
  "outcome",
  "decision",
  "resolvedBy",
  "reviewedBy",
  "changedBy",
  "publishedBy",
  "installedBy",
  "activatedBy",
  "actorId",
  "approvalId",
  "installId",
  "releaseId",
  "versionId",
  "bindingId",
  "toolExecutionId",
  "workflowRunId",
  "conversationId",
  "resourceId",
  "id",
  "traceId",
  "generationRunId",
  "requestId",
] as const;

export async function getWorkspaceAuditSnapshot(input: WorkspaceAuditQueryInput & {
  cursor?: string | null;
  limit?: number;
}): Promise<WorkspaceAuditSnapshot | null> {
  const limit = normalizeAuditLimit(input.limit);
  const normalizedQuery = normalizeAuditQuery(input.query);
  const category = normalizeAuditCategory(input.category);
  const cursor = decodeWorkspaceAuditCursor(input.cursor);

  if (!process.env.DATABASE_URL?.trim()) {
    if (input.activeRepresentativeSlug !== demoRepresentative.slug) return null;
    return {
      workspace: { ownerId: input.ownerId?.trim() || "demo-owner", representativeCount: 1 },
      metrics: { total: 0, last24Hours: 0, decisions: 0, anomalies: 0 },
      categories: workspaceAuditCategories.map((id) => ({ id, count: 0 })),
      page: { filteredTotal: 0, limit, hasMore: false, nextCursor: null },
      events: [],
    };
  }

  const context = await resolveWorkspaceAuditContext(input);
  if (!context) return null;

  const baseWhere = buildWorkspaceOwnerScopeWhere(context.ownerId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    representativeCount,
    typeCounts,
    last24Hours,
    anomalies,
    filteredTotal,
    records,
  ] = await Promise.all([
    prisma.representative.count({ where: { ownerId: context.ownerId } }),
    prisma.eventAudit.groupBy({
      by: ["type"],
      where: baseWhere,
      _count: { _all: true },
    }),
    prisma.eventAudit.count({
      where: {
        AND: [
          baseWhere,
          { createdAt: { gte: cutoff, lte: now } },
        ],
      },
    }),
    countWorkspaceAuditAnomalies(context.ownerId),
    countFilteredWorkspaceAuditEvents({
      ownerId: context.ownerId,
      category,
      query: normalizedQuery,
    }),
    findFilteredWorkspaceAuditEvents({
      ownerId: context.ownerId,
      category,
      query: normalizedQuery,
      cursor,
      take: limit + 1,
    }),
  ]);

  const hasMore = records.length > limit;
  const pageRecords = records.slice(0, limit);
  const typeSummary = summarizeWorkspaceAuditTypeCounts(
    typeCounts.map((entry) => ({ type: entry.type, count: entry._count._all })),
  );

  return {
    workspace: { ownerId: context.ownerId, representativeCount },
    metrics: {
      total: typeSummary.total,
      last24Hours,
      decisions: typeSummary.decisions,
      anomalies,
    },
    categories: typeSummary.categories,
    page: {
      filteredTotal,
      limit,
      hasMore,
      nextCursor: hasMore && pageRecords.length
        ? encodeWorkspaceAuditCursor(pageRecords[pageRecords.length - 1]!)
        : null,
    },
    events: pageRecords.map(serializeWorkspaceAuditEvent),
  };
}

export async function getWorkspaceAuditExport(
  input: WorkspaceAuditQueryInput,
): Promise<WorkspaceAuditExport | null> {
  const normalizedQuery = normalizeAuditQuery(input.query);
  const category = normalizeAuditCategory(input.category);

  if (!process.env.DATABASE_URL?.trim()) {
    if (input.activeRepresentativeSlug !== demoRepresentative.slug) return null;
    return {
      filteredTotal: 0,
      events: emptyWorkspaceAuditEvents(),
    };
  }

  const context = await resolveWorkspaceAuditContext(input);
  if (!context) return null;

  const query = {
    ownerId: context.ownerId,
    category,
    query: normalizedQuery,
  };
  const firstRecords = await findFilteredWorkspaceAuditEvents({
    ...query,
    take: exportPageSize + 1,
  });
  const anchor = firstRecords[0];
  if (!anchor) {
    return {
      filteredTotal: 0,
      events: emptyWorkspaceAuditEvents(),
    };
  }

  // Anchor the export at its first record so events appended while the stream is
  // running cannot move page boundaries or appear halfway through the file.
  const exportAnchor = {
    createdAt: anchor.createdAt,
    id: anchor.id,
  };
  const filteredTotal = await countFilteredWorkspaceAuditEvents({
    ...query,
    anchor: exportAnchor,
  });

  return {
    filteredTotal,
    events: streamWorkspaceAuditEvents({
      firstRecords,
      query,
      anchor: exportAnchor,
    }),
  };
}

export function summarizeWorkspaceAuditTypeCounts(
  counts: Array<{ type: string; count: number }>,
) {
  const countByCategory = new Map<WorkspaceAuditCategory, number>(
    workspaceAuditCategories.map((category) => [category, 0]),
  );
  let total = 0;
  let decisions = 0;

  for (const entry of counts) {
    const count = Number.isFinite(entry.count) && entry.count > 0
      ? Math.floor(entry.count)
      : 0;
    const normalizedType = entry.type.toLowerCase();
    const category = classifyWorkspaceAuditEvent(normalizedType);
    total += count;
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + count);
    if (isAuditDecisionType(normalizedType, category)) {
      decisions += count;
    }
  }

  return {
    total,
    decisions,
    categories: workspaceAuditCategories.map((id) => ({
      id,
      count: countByCategory.get(id) ?? 0,
    })),
  };
}

export function countWorkspaceAuditEventsWithinLast24Hours(
  events: Array<{ createdAt: string }>,
  now = new Date(),
) {
  const nowMs = now.getTime();
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  return events.filter((event) => {
    const createdAtMs = new Date(event.createdAt).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= cutoffMs && createdAtMs <= nowMs;
  }).length;
}

export function encodeWorkspaceAuditCursor(value: { createdAt: Date | string; id: string }) {
  const createdAt = value.createdAt instanceof Date
    ? value.createdAt
    : new Date(value.createdAt);
  if (
    !Number.isFinite(createdAt.getTime())
    || !value.id.trim()
    || value.id.length > 191
  ) {
    throw new WorkspaceAuditInputError("Invalid audit cursor.");
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    createdAt: createdAt.toISOString(),
    id: value.id,
  }), "utf8").toString("base64url");
}

export function decodeWorkspaceAuditCursor(
  value?: string | null,
): WorkspaceAuditCursor | null {
  if (!value) return null;
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) {
    throw new WorkspaceAuditInputError("Invalid audit cursor.");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      decoded.v !== 1
      || typeof decoded.createdAt !== "string"
      || typeof decoded.id !== "string"
      || !decoded.id.trim()
      || decoded.id.length > 191
    ) {
      throw new Error("invalid shape");
    }
    const createdAt = new Date(decoded.createdAt);
    if (
      !Number.isFinite(createdAt.getTime())
      || createdAt.toISOString() !== decoded.createdAt
    ) {
      throw new Error("invalid timestamp");
    }
    return { createdAt, id: decoded.id };
  } catch {
    throw new WorkspaceAuditInputError("Invalid audit cursor.");
  }
}

export function classifyWorkspaceAuditEvent(type: string): WorkspaceAuditCategory {
  const normalized = type.toLowerCase();
  if (normalized.startsWith("owner_profile_") || normalized.startsWith("owner_notification_")) return "settings";
  if (normalized.startsWith("skill_")) return "skills";
  if (normalized.includes("approval")) return "approvals";
  if (normalized.includes("wallet") || normalized.includes("payment") || normalized.includes("invoice") || normalized.includes("recharge")) return "wallet";
  if (normalized.includes("tool") || normalized.includes("compute") || normalized.includes("browser") || normalized.includes("mcp")) return "tools";
  if (normalized.includes("workflow") || normalized.includes("delegation_task")) return "workflow";
  if (normalized.includes("published") || normalized.includes("version_activated") || normalized.includes("channel")) return "publishing";
  if (normalized.includes("conversation") || normalized.includes("message") || normalized.includes("handoff") || normalized.includes("lead")) return "conversation";
  if (normalized.includes("login") || normalized.includes("auth") || normalized.includes("policy") || normalized.includes("security")) return "security";
  return "other";
}

export function buildWorkspaceAuditSafeMetadata(payload: Record<string, unknown> | null) {
  const safeKeys = [
    "status",
    "source",
    "version",
    "installedVersion",
    "latestVersion",
    "enabled",
    "updatePolicy",
    "previousPolicy",
    "signatureStatus",
    "riskScore",
    "decision",
    "operation",
    "approvalRequired",
    "allowedToolCount",
  ];
  return Object.fromEntries(safeKeys.flatMap((key) => {
    const value = payload?.[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
      ? [[key, value] as const]
      : [];
  }));
}

function normalizeAuditLimit(value?: number) {
  const normalized = value ?? defaultPageSize;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximumPageSize) {
    throw new WorkspaceAuditInputError(
      `Audit page size must be between 1 and ${maximumPageSize}.`,
    );
  }
  return normalized;
}

function normalizeAuditQuery(value?: string) {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximumQueryLength || normalized.includes("\0")) {
    throw new WorkspaceAuditInputError(
      `Audit search must be at most ${maximumQueryLength} characters.`,
    );
  }
  return normalized;
}

function normalizeAuditCategory(
  value?: WorkspaceAuditCategory | "all",
): WorkspaceAuditCategory | "all" {
  const normalized = value ?? "all";
  if (
    normalized !== "all"
    && !workspaceAuditCategories.includes(normalized)
  ) {
    throw new WorkspaceAuditInputError("Invalid audit category.");
  }
  return normalized;
}

async function resolveWorkspaceAuditContext(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
}) {
  const ownerId = input.ownerId?.trim();
  if (ownerId) {
    return { ownerId };
  }
  const representative = await prisma.representative.findFirst({
    where: {
      slug: input.activeRepresentativeSlug,
    },
    select: { ownerId: true },
  });
  if (!representative) return null;
  return { ownerId: representative.ownerId };
}

function buildWorkspaceAuditWhere(input: {
  ownerId: string;
  category: WorkspaceAuditCategory | "all";
  cursor?: WorkspaceAuditCursor | null;
  anchor?: WorkspaceAuditCursor | null;
}): Prisma.EventAuditWhereInput {
  const conditions: Prisma.EventAuditWhereInput[] = [
    buildWorkspaceOwnerScopeWhere(input.ownerId),
  ];
  if (input.category !== "all") {
    conditions.push({ type: { in: eventTypesByCategory[input.category] } });
  }
  if (input.cursor) {
    conditions.push(buildAfterAuditCursorWhere(input.cursor));
  }
  if (input.anchor) {
    conditions.push(buildAtOrBeforeAuditCursorWhere(input.anchor));
  }
  return { AND: conditions };
}

function buildAfterAuditCursorWhere(
  cursor: WorkspaceAuditCursor,
): Prisma.EventAuditWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        AND: [
          { createdAt: cursor.createdAt },
          { id: { lt: cursor.id } },
        ],
      },
    ],
  };
}

function buildAtOrBeforeAuditCursorWhere(
  cursor: WorkspaceAuditCursor,
): Prisma.EventAuditWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        AND: [
          { createdAt: cursor.createdAt },
          { id: { lte: cursor.id } },
        ],
      },
    ],
  };
}

async function countFilteredWorkspaceAuditEvents(input: {
  ownerId: string;
  category: WorkspaceAuditCategory | "all";
  query: string;
  anchor?: WorkspaceAuditCursor | null;
}) {
  if (!input.query) {
    return prisma.eventAudit.count({
      where: buildWorkspaceAuditWhere(input),
    });
  }
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS "count"
    FROM "EventAudit" AS e
    LEFT JOIN "Representative" AS r ON r."id" = e."representativeId"
    WHERE ${buildWorkspaceAuditRawWhere(input)}
  `);
  return Number(rows[0]?.count ?? 0);
}

async function findFilteredWorkspaceAuditEvents(input: {
  ownerId: string;
  category: WorkspaceAuditCategory | "all";
  query: string;
  cursor?: WorkspaceAuditCursor | null;
  anchor?: WorkspaceAuditCursor | null;
  take: number;
}): Promise<WorkspaceAuditRecord[]> {
  if (!input.query) {
    return prisma.eventAudit.findMany({
      where: buildWorkspaceAuditWhere(input),
      select: workspaceAuditRecordSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    });
  }
  const rows = await prisma.$queryRaw<Array<{
    id: string;
    type: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
    representativeSlug: string | null;
    representativeName: string | null;
  }>>(Prisma.sql`
    SELECT
      e."id",
      e."type"::text AS "type",
      e."payload",
      e."createdAt",
      r."slug" AS "representativeSlug",
      r."displayName" AS "representativeName"
    FROM "EventAudit" AS e
    LEFT JOIN "Representative" AS r ON r."id" = e."representativeId"
    WHERE ${buildWorkspaceAuditRawWhere(input)}
    ORDER BY e."createdAt" DESC, e."id" DESC
    LIMIT ${input.take}
  `);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt,
    representative: row.representativeSlug && row.representativeName
      ? {
          slug: row.representativeSlug,
          displayName: row.representativeName,
        }
      : null,
  }));
}

function buildWorkspaceAuditRawWhere(input: {
  ownerId: string;
  category: WorkspaceAuditCategory | "all";
  query: string;
  cursor?: WorkspaceAuditCursor | null;
  anchor?: WorkspaceAuditCursor | null;
}) {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`(
      e."ownerId" = ${input.ownerId}
      OR (e."ownerId" IS NULL AND r."ownerId" = ${input.ownerId})
    )`,
  ];
  if (input.category !== "all") {
    const categoryEventTypes = eventTypesByCategory[input.category];
    clauses.push(categoryEventTypes.length
      ? Prisma.sql`
          e."type"::text IN (${Prisma.join(categoryEventTypes)})
        `
      : Prisma.sql`FALSE`);
  }
  if (input.query) {
    const needle = input.query.toLowerCase();
    const whitelistedPayloadSearch = searchablePayloadKeys.map((key) => Prisma.sql`
      STRPOS(LOWER(COALESCE(e."payload" ->> ${key}, '')), ${needle}) > 0
    `);
    clauses.push(Prisma.sql`
      (
        STRPOS(LOWER(e."id"), ${needle}) > 0
        OR STRPOS(LOWER(COALESCE(r."displayName", '')), ${needle}) > 0
        OR STRPOS(LOWER(e."type"::text), ${needle}) > 0
        OR STRPOS(LOWER(REPLACE(e."type"::text, '_', ' ')), ${needle}) > 0
        OR ${Prisma.join(whitelistedPayloadSearch, " OR ")}
      )
    `);
  }
  if (input.cursor) {
    clauses.push(Prisma.sql`
      (
        e."createdAt" < ${input.cursor.createdAt}
        OR (
          e."createdAt" = ${input.cursor.createdAt}
          AND e."id" < ${input.cursor.id}
        )
      )
    `);
  }
  if (input.anchor) {
    clauses.push(Prisma.sql`
      (
        e."createdAt" < ${input.anchor.createdAt}
        OR (
          e."createdAt" = ${input.anchor.createdAt}
          AND e."id" <= ${input.anchor.id}
        )
      )
    `);
  }
  return Prisma.join(clauses, " AND ");
}

async function countWorkspaceAuditAnomalies(ownerId: string) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS "count"
    FROM "EventAudit" AS e
    LEFT JOIN "Representative" AS r ON r."id" = e."representativeId"
    WHERE (
      e."ownerId" = ${ownerId}
      OR (e."ownerId" IS NULL AND r."ownerId" = ${ownerId})
    )
      AND (
        e."type"::text IN (${Prisma.join(anomalyEventTypes)})
        OR LOWER(COALESCE(e."payload" ->> ${"status"}, ''))
          IN (${Prisma.join(anomalyPayloadValues)})
        OR LOWER(COALESCE(e."payload" ->> ${"outcome"}, ''))
          IN (${Prisma.join(anomalyPayloadValues)})
      )
  `);
  return Number(rows[0]?.count ?? 0);
}

function serializeWorkspaceAuditEvent(record: WorkspaceAuditRecord): WorkspaceAuditEvent {
  const type = record.type.toLowerCase();
  const payload = asRecord(record.payload);
  const category = classifyWorkspaceAuditEvent(type);
  const resource = resolveAuditResource(payload, category);
  return {
    id: record.id,
    type,
    category,
    representativeSlug: record.representative?.slug ?? null,
    representativeName: record.representative?.displayName ?? null,
    actor: firstString(payload, ["resolvedBy", "reviewedBy", "changedBy", "publishedBy", "installedBy", "activatedBy", "actorId"]),
    summary: buildAuditSummary(type, payload),
    resource,
    traceId: firstString(payload, ["traceId", "workflowRunId", "generationRunId", "requestId"]),
    anomaly: isAuditAnomaly(type, payload),
    metadata: buildWorkspaceAuditSafeMetadata(payload),
    createdAt: record.createdAt.toISOString(),
  };
}

async function* streamWorkspaceAuditEvents(input: {
  firstRecords: WorkspaceAuditRecord[];
  query: {
    ownerId: string;
    category: WorkspaceAuditCategory | "all";
    query: string;
  };
  anchor: WorkspaceAuditCursor;
}): AsyncGenerator<WorkspaceAuditEvent> {
  let records = input.firstRecords;

  while (records.length) {
    const pageRecords = records.slice(0, exportPageSize);
    for (const record of pageRecords) {
      yield serializeWorkspaceAuditEvent(record);
    }
    if (records.length <= exportPageSize || !pageRecords.length) return;

    const lastRecord = pageRecords[pageRecords.length - 1]!;
    records = await findFilteredWorkspaceAuditEvents({
      ...input.query,
      anchor: input.anchor,
      cursor: {
        createdAt: lastRecord.createdAt,
        id: lastRecord.id,
      },
      take: exportPageSize + 1,
    });
  }
}

async function* emptyWorkspaceAuditEvents(): AsyncGenerator<WorkspaceAuditEvent> {
  return;
}

function isAuditDecisionType(
  type: string,
  category = classifyWorkspaceAuditEvent(type),
) {
  return category === "approvals"
    || type.includes("approved")
    || type.includes("rejected")
    || type.includes("adopted");
}

function buildAuditSummary(type: string, payload: Record<string, unknown> | null) {
  const label = type.replaceAll("_", " ");
  const slug = firstString(payload, ["slug", "skillSlug", "representativeSlug"]);
  const version = firstString(payload, ["version", "installedVersion"]);
  const status = firstString(payload, ["status", "outcome", "decision"]);
  return [label, slug, version ? `v${version}` : null, status].filter(Boolean).join(" · ");
}

function resolveAuditResource(
  payload: Record<string, unknown> | null,
  category: WorkspaceAuditCategory,
) {
  const candidates: Array<[string, string]> = [
    ["approval", firstString(payload, ["approvalId"]) ?? ""],
    ["skill_install", firstString(payload, ["installId"]) ?? ""],
    ["skill_release", firstString(payload, ["releaseId"]) ?? ""],
    ["representative_version", firstString(payload, ["versionId"]) ?? ""],
    ["mcp_binding", firstString(payload, ["bindingId"]) ?? ""],
    ["tool_execution", firstString(payload, ["toolExecutionId"]) ?? ""],
    ["workflow_run", firstString(payload, ["workflowRunId"]) ?? ""],
    ["conversation", firstString(payload, ["conversationId"]) ?? ""],
  ];
  const resolved = candidates.find(([, id]) => Boolean(id));
  if (resolved) return { kind: resolved[0], id: resolved[1] };
  const genericId = firstString(payload, ["resourceId", "id"]);
  return genericId ? { kind: category, id: genericId } : null;
}

function isAuditAnomaly(type: string, payload: Record<string, unknown> | null) {
  if (anomalyTypeTokens.some((token) => type.includes(token))) return true;
  const status = firstString(payload, ["status", "outcome"])?.toLowerCase();
  return Boolean(status && anomalyPayloadValues.includes(status));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(value: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

const workspaceAuditRecordSelect = {
  id: true,
  type: true,
  payload: true,
  createdAt: true,
  representative: {
    select: {
      slug: true,
      displayName: true,
    },
  },
} satisfies Prisma.EventAuditSelect;

export function buildWorkspaceOwnerScopeWhere(
  ownerId: string,
): Prisma.EventAuditWhereInput {
  return {
    OR: [
      { ownerId },
      {
        AND: [
          { ownerId: null },
          { representative: { ownerId } },
        ],
      },
    ],
  };
}
