import type { RepresentativeRuntimeMcpBindingGrant } from "@delegate/web-data";

import { normalizeMcpHealthFailureCode } from "./mcp-health-failure";
import { SessionError } from "./session-error";
import { prisma } from "./prisma";

export type RepresentativeMcpBindingHealthObservation = {
  bindingId: string;
  configRevision: number;
  requestGeneration: bigint;
  startedAt: Date;
};

export type McpBindingHealthObservationOrder = Pick<
  RepresentativeMcpBindingHealthObservation,
  "requestGeneration" | "startedAt"
>;

export async function loadRepresentativeMcpBinding(params: {
  representativeId: string;
  bindingId?: string | null | undefined;
  bindingSlug?: string | null | undefined;
  requireEnabled?: boolean;
  runtimeGrants?: RepresentativeRuntimeMcpBindingGrant[] | undefined;
}) {
  if (!params.bindingId && !params.bindingSlug) {
    throw new SessionError(400, "mcp_binding_reference_required");
  }

  const binding = params.bindingId
    ? await prisma.representativeMcpBinding.findFirst({
        where: {
          id: params.bindingId,
          representativeId: params.representativeId,
        },
      })
    : await prisma.representativeMcpBinding.findFirst({
        where: {
          representativeId: params.representativeId,
          ...(params.bindingSlug ? { slug: params.bindingSlug } : {}),
        },
      });

  if (!binding) {
    throw new SessionError(404, "mcp_binding_not_found");
  }

  if ((params.requireEnabled ?? true) && !binding.enabled) {
    throw new SessionError(409, "mcp_binding_disabled");
  }

  return params.runtimeGrants
    ? applyRepresentativeMcpBindingGrant(binding, params.runtimeGrants)
    : binding;
}

export function applyRepresentativeMcpBindingGrant<
  T extends {
    id: string;
    slug: string;
    serverUrl: string;
    transportKind: string;
    allowedToolNames: unknown;
    defaultToolName: string | null;
    approvalRequired: boolean;
    estimatedCostCentsPerCall: number;
    maxRetries: number;
    retryBackoffMs: number;
  },
>(
  binding: T,
  runtimeGrants: RepresentativeRuntimeMcpBindingGrant[],
): T & {
  allowedToolNames: string[];
  defaultToolName: string | null;
  approvalRequired: boolean;
  estimatedCostCentsPerCall: number;
  maxRetries: number;
  retryBackoffMs: number;
} {
  const grant = runtimeGrants.find(
    (candidate) => candidate.id === binding.id && candidate.slug === binding.slug,
  );
  if (
    !grant ||
    binding.serverUrl !== grant.serverUrl ||
    binding.transportKind.toLowerCase() !== grant.transportKind
  ) {
    throw new SessionError(403, "mcp_binding_not_granted_by_published_version");
  }

  const currentAllowedToolNames = parseAllowedToolNames(binding.allowedToolNames);
  const allowedToolNames = intersectAllowedToolNames(
    currentAllowedToolNames,
    grant.allowedToolNames,
  );
  if (
    currentAllowedToolNames.length &&
    grant.allowedToolNames.length &&
    !allowedToolNames.length
  ) {
    throw new SessionError(403, "mcp_binding_has_no_currently_granted_tools");
  }
  const defaultToolName = resolveGrantedDefaultToolName(
    binding.defaultToolName,
    grant.defaultToolName,
    allowedToolNames,
  );

  return {
    ...binding,
    allowedToolNames,
    defaultToolName,
    approvalRequired: binding.approvalRequired || grant.approvalRequired,
    estimatedCostCentsPerCall: Math.max(
      binding.estimatedCostCentsPerCall,
      grant.estimatedCostCentsPerCall,
    ),
    maxRetries: Math.min(binding.maxRetries, grant.maxRetries),
    retryBackoffMs: Math.max(binding.retryBackoffMs, grant.retryBackoffMs),
  };
}

export function parseAllowedToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function intersectAllowedToolNames(current: string[], granted: string[]): string[] {
  if (!current.length) return [...granted];
  if (!granted.length) return [...current];
  const grantedSet = new Set(granted);
  return current.filter((toolName) => grantedSet.has(toolName));
}

function resolveGrantedDefaultToolName(
  current: string | null,
  granted: string | null,
  allowedToolNames: string[],
): string | null {
  const candidates = [current, granted]
    .map((value) => value?.trim() || null)
    .filter((value): value is string => Boolean(value));
  if (!allowedToolNames.length) return candidates[0] ?? null;
  return candidates.find((value) => allowedToolNames.includes(value))
    ?? allowedToolNames[0]
    ?? null;
}

export function resolveMcpToolName(params: {
  binding: {
    allowedToolNames: unknown;
    defaultToolName: string | null;
  };
  requestedToolName?: string | null | undefined;
}) {
  const allowedToolNames = parseAllowedToolNames(params.binding.allowedToolNames);
  const toolName =
    params.requestedToolName?.trim() ||
    params.binding.defaultToolName?.trim() ||
    allowedToolNames[0];

  if (!toolName) {
    throw new SessionError(400, "mcp_tool_name_required");
  }

  if (allowedToolNames.length > 0 && !allowedToolNames.includes(toolName)) {
    throw new SessionError(403, "mcp_tool_not_allowed_for_binding");
  }

  return {
    toolName,
    allowedToolNames,
  };
}

export function isNewerMcpBindingHealthObservation(
  candidate: McpBindingHealthObservationOrder,
  current: McpBindingHealthObservationOrder | null,
) {
  if (!current) return true;
  const startedAtDelta = candidate.startedAt.getTime() - current.startedAt.getTime();
  if (startedAtDelta !== 0) return startedAtDelta > 0;
  return candidate.requestGeneration > current.requestGeneration;
}

export async function beginRepresentativeMcpBindingHealthObservation(params: {
  bindingId: string;
  configRevision: number;
  startedAt: Date;
}): Promise<RepresentativeMcpBindingHealthObservation | null> {
  if (
    !params.bindingId
    || !Number.isInteger(params.configRevision)
    || params.configRevision < 1
    || !isValidDate(params.startedAt)
  ) {
    return null;
  }

  // Health traffic must not mutate the configuration's @updatedAt optimistic-lock token.
  const rows = await prisma.$queryRaw<Array<{
    configRevision: number;
    requestGeneration: bigint;
  }>>`
    UPDATE "RepresentativeMcpBinding"
    SET "healthRequestGeneration" = "healthRequestGeneration" + 1
    WHERE "id" = ${params.bindingId}
      AND "configRevision" = ${params.configRevision}
    RETURNING
      "configRevision",
      "healthRequestGeneration" AS "requestGeneration"
  `;
  const claimed = rows[0];
  if (!claimed) return null;

  return {
    bindingId: params.bindingId,
    configRevision: claimed.configRevision,
    requestGeneration: claimed.requestGeneration,
    startedAt: new Date(params.startedAt),
  };
}

export async function recordRepresentativeMcpBindingSuccess(params: {
  observation: RepresentativeMcpBindingHealthObservation;
  completedAt?: Date;
}) {
  const completedAt = params.completedAt ?? new Date();
  if (!isValidHealthObservation(params.observation) || !isValidDate(completedAt)) {
    return false;
  }

  // Keep this ordering predicate aligned with isNewerMcpBindingHealthObservation.
  const updatedCount = await prisma.$executeRaw`
    UPDATE "RepresentativeMcpBinding"
    SET
      "lastHealthObservationGeneration" = ${params.observation.requestGeneration},
      "lastHealthObservationStartedAt" = ${params.observation.startedAt},
      "consecutiveFailures" = 0,
      "lastSuccessAt" = ${completedAt}
    WHERE "id" = ${params.observation.bindingId}
      AND "configRevision" = ${params.observation.configRevision}
      AND (
        "lastHealthObservationStartedAt" IS NULL
        OR "lastHealthObservationStartedAt" < ${params.observation.startedAt}
        OR (
          "lastHealthObservationStartedAt" = ${params.observation.startedAt}
          AND "lastHealthObservationGeneration" < ${params.observation.requestGeneration}
        )
      )
  `;
  return updatedCount === 1;
}

export async function recordRepresentativeMcpBindingFailure(params: {
  observation: RepresentativeMcpBindingHealthObservation;
  failureReason: string;
  completedAt?: Date;
}) {
  const completedAt = params.completedAt ?? new Date();
  if (!isValidHealthObservation(params.observation) || !isValidDate(completedAt)) {
    return false;
  }
  const failureReason = normalizeMcpHealthFailureCode(params.failureReason);

  // Keep this ordering predicate aligned with isNewerMcpBindingHealthObservation.
  const updatedCount = await prisma.$executeRaw`
    UPDATE "RepresentativeMcpBinding"
    SET
      "lastHealthObservationGeneration" = ${params.observation.requestGeneration},
      "lastHealthObservationStartedAt" = ${params.observation.startedAt},
      "consecutiveFailures" = CASE
        WHEN "lastHealthObservationStartedAt" IS NOT NULL
          AND "lastHealthObservationGeneration" + 1 = ${params.observation.requestGeneration}
        THEN "consecutiveFailures" + 1
        ELSE 1
      END,
      "lastFailureAt" = ${completedAt},
      "lastFailureReason" = ${failureReason}
    WHERE "id" = ${params.observation.bindingId}
      AND "configRevision" = ${params.observation.configRevision}
      AND (
        "lastHealthObservationStartedAt" IS NULL
        OR "lastHealthObservationStartedAt" < ${params.observation.startedAt}
        OR (
          "lastHealthObservationStartedAt" = ${params.observation.startedAt}
          AND "lastHealthObservationGeneration" < ${params.observation.requestGeneration}
        )
      )
  `;
  return updatedCount === 1;
}

function isValidHealthObservation(
  observation: RepresentativeMcpBindingHealthObservation,
) {
  return Boolean(observation.bindingId)
    && Number.isInteger(observation.configRevision)
    && observation.configRevision >= 1
    && observation.requestGeneration > 0n
    && isValidDate(observation.startedAt);
}

function isValidDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}
