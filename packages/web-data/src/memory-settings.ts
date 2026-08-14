import { createHash } from "node:crypto";

import {
  buildGovernedMemoryManagedUserId,
  resolveOpenVikingEnv,
} from "@delegate/openviking";
import {
  EventType,
  GovernedMemoryStatus,
  MemoryExpiryAction,
  MemoryProjectionLane,
  MemoryProjectionStatus,
  MemoryReconciliationStatus,
  MemoryScope,
  OrganizationMemberRole,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u;
const identifier = z.string().trim().min(1).max(191).regex(identifierPattern);
const isoDateTime = z.string().trim().datetime({ offset: true });
const reconciliationIntervalMinutes = 5;
const reconciliationFreshnessIntervals = 3;

export const representativeMemorySettingsQuerySchema = z.object({
  rep: identifier,
}).strict();

const memorySettingsPolicyShape = z.object({
  basic: z.object({
    longTermMemoryEnabled: z.boolean(),
    shortTermMemoryEnabled: z.boolean().default(true),
    contactMemoryEnabled: z.boolean(),
    contactMemoryCrossChannelEnabled: z.boolean().default(true),
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
  policy: memorySettingsPolicyShape,
}).strict();

export const representativeMemorySettingsUpdateSchema = z.object({
  expectedRevision: z.number().int().min(0),
  policy: memorySettingsPolicyShape,
}).strict().superRefine((value, context) => {
  const { basic, channels } = value.policy;
  const anyLongTermType = basic.contactMemoryEnabled
    || basic.representativeExperienceEnabled;
  const anyRecall = Object.values(channels).some((channel) => channel.recallEnabled);
  const anyExtract = Object.values(channels).some((channel) => channel.extractEnabled);

  // Short-term memory is an episode-local capability. It remains independent
  // from the durable-memory switch and is therefore deliberately excluded.
  if (!basic.longTermMemoryEnabled && (
    anyLongTermType
    || basic.autoExtract
    || anyRecall
    || anyExtract
  )) {
    context.addIssue({
      code: "custom",
      path: ["policy", "basic", "longTermMemoryEnabled"],
      message: "Long-term memory must be enabled before durable-memory capabilities.",
    });
  }
  if (basic.autoExtract && !anyLongTermType) {
    context.addIssue({
      code: "custom",
      path: ["policy", "basic", "autoExtract"],
      message: "Automatic extraction requires Contact Memory or Representative Experience.",
    });
  }
  if (anyRecall && (!basic.longTermMemoryEnabled || !anyLongTermType)) {
    context.addIssue({
      code: "custom",
      path: ["policy", "channels"],
      message: "Channel recall requires an enabled durable-memory type.",
    });
  }
  if (anyExtract && (!basic.autoExtract || !anyLongTermType)) {
    context.addIssue({
      code: "custom",
      path: ["policy", "channels"],
      message: "Channel extraction requires automatic extraction and an enabled durable-memory type.",
    });
  }
});

export type RepresentativeMemorySettingsUpdate = z.infer<
  typeof representativeMemorySettingsUpdateSchema
>;

export type MemorySettingsErrorCode =
  | "memory_dashboard_not_found"
  | "memory_dashboard_forbidden"
  | "memory_dashboard_version_conflict"
  | "memory_dashboard_idempotency_conflict"
  | "memory_dashboard_state_conflict";

export class MemorySettingsError extends Error {
  constructor(
    readonly code: MemorySettingsErrorCode,
    message: string,
    readonly statusCode: 403 | 404 | 409,
  ) {
    super(message);
    this.name = "MemorySettingsError";
  }
}

type MemorySettingsClient = PrismaClient;

export type RepresentativeMemorySettingsOptions = {
  client?: MemorySettingsClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

type MemorySettingsActor = {
  actorOwnerId: string;
  representativeId: string;
  representativeSlug: string;
  representativeName: string;
  role: "OWNER" | "ADMIN" | "REVIEWER";
};

type SyncProjectionRow = {
  status: MemoryProjectionStatus;
  _count: { _all: number };
};

type SyncProjectionError = {
  lastErrorCode: string | null;
  updatedAt: Date;
} | null;

type SyncReconciliationRun = {
  status: MemoryReconciliationStatus;
  finishedAt: Date | null;
  errorCode: string | null;
  issueCount: number;
  updatedAt: Date;
} | null;

type SyncSnapshotClient = {
  memoryProjectionItem: {
    groupBy(input: unknown): Promise<SyncProjectionRow[]>;
    aggregate(input: unknown): Promise<{ _max: { projectedAt: Date | null } }>;
    findFirst(input: unknown): Promise<SyncProjectionError>;
  };
  memoryReconciliationRun: {
    findFirst(input: unknown): Promise<SyncReconciliationRun>;
  };
};

type MemorySyncSnapshot = {
  providerStatus: "HEALTHY" | "AVAILABLE" | "DEGRADED" | "PARTIAL" | "DISABLED" | "FAILED" | null;
  connectionStatus: "CONFIGURED" | "DISABLED" | "MISCONFIGURED";
  operationalStatus: "HEALTHY" | "AVAILABLE" | "IDLE" | "DEGRADED" | "FAILED";
  inventoryCoverage: "KNOWN_PROJECTIONS_ONLY";
  capabilityCode: "openviking_inventory_no_snapshot_cursor";
  queuedCount: number;
  activeCount: number;
  retryingCount: number;
  failedCount: number;
  deletePendingCount: number;
  lastProjectedAt: string | null;
  lastReconciledAt: string | null;
  lastErrorCode: string | null;
  reconciliationIntervalMinutes: number;
  retryStrategy: "capped_exponential_backoff_with_leases";
};

export async function getRepresentativeMemorySettings(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
  },
  options: RepresentativeMemorySettingsOptions = {},
) {
  const client = options.client ?? prisma;
  const actor = await resolveMemorySettingsActor(
    client,
    input.actorOwnerId,
    input.representativeSlug,
  );
  assertMemorySettingsActor(actor);
  const policy = await client.representativeMemoryPolicy.findUnique({
    where: { representativeId: actor.representativeId },
  });
  const sync = await loadMemorySyncSnapshot(
    client,
    actor.representativeId,
    policy?.provider ?? "openviking",
    options.env ?? process.env,
    options.now?.() ?? new Date(),
  );
  return serializeMemorySettings({ actor, policy, sync });
}

export async function updateRepresentativeMemorySettings(
  input: {
    actorOwnerId: string;
    representativeSlug: string;
    requestId: string;
    idempotencyKey: string;
    update: unknown;
  },
  options: RepresentativeMemorySettingsOptions = {},
) {
  const parsedInput = representativeMemorySettingsUpdateSchema.parse(input.update);
  const parsed = {
    ...parsedInput,
    policy: withSystemManagedCrossChannelCapability(parsedInput.policy),
  };
  const requestId = identifier.parse(input.requestId);
  const idempotencyKey = identifier.parse(input.idempotencyKey);
  const client = options.client ?? prisma;
  const requestHash = sha256({
    operation: "memory_settings_update",
    representativeSlug: input.representativeSlug,
    update: parsed,
  });
  const legacyRequestHash = sha256({
    operation: "memory_settings_update",
    representativeSlug: input.representativeSlug,
    update: legacyCompatibleUpdate(parsed),
  });

  try {
    const result = await runWithPrismaWriteConflictRetry(
      () => client.$transaction(async (tx) => {
        const actor = await resolveMemorySettingsActor(
          tx,
          input.actorOwnerId,
          input.representativeSlug,
        );
        assertMemorySettingsActor(actor);
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
            || (
              replay.requestHash !== requestHash
              && replay.requestHash !== legacyRequestHash
            )
            || replay.representativeId !== actor.representativeId
          ) {
            throw new MemorySettingsError(
              "memory_dashboard_idempotency_conflict",
              "This idempotency key belongs to a different memory request.",
              409,
            );
          }
          const replayResult = readStoredMemorySettingsResult(replay.payload);
          if (!replayResult) {
            throw new MemorySettingsError(
              "memory_dashboard_idempotency_conflict",
              "The memory settings replay record is invalid.",
              409,
            );
          }
          const currentPolicy = await tx.representativeMemoryPolicy.findUnique({
            where: { representativeId: actor.representativeId },
            select: {
              managedAgentId: true,
              namespaceKey: true,
              managedTargetUri: true,
            },
          });
          return {
            replayed: true,
            actor,
            configured: true,
            revision: replayResult.revision,
            updatedAt: replayResult.updatedAt,
            policy: replayResult.policy,
            managed: {
              agentId: currentPolicy?.managedAgentId ?? null,
              namespace: currentPolicy?.namespaceKey ?? null,
              targetUri: currentPolicy?.managedTargetUri ?? null,
            },
          };
        }

        const current = await tx.representativeMemoryPolicy.findUnique({
          where: { representativeId: actor.representativeId },
        });
        if ((current?.revision ?? 0) !== parsed.expectedRevision) {
          throw versionConflict();
        }

        const data = policyUpdateData(parsed.policy);
        let updated;
        if (current) {
          const write = await tx.representativeMemoryPolicy.updateMany({
            where: {
              representativeId: actor.representativeId,
              revision: parsed.expectedRevision,
            },
            data: { ...data, revision: { increment: 1 } },
          });
          if (write.count !== 1) throw versionConflict();
          updated = await tx.representativeMemoryPolicy.findUniqueOrThrow({
            where: { representativeId: actor.representativeId },
          });
        } else {
          if (parsed.expectedRevision !== 0) throw versionConflict();
          updated = await tx.representativeMemoryPolicy.create({
            data: {
              representativeId: actor.representativeId,
              namespaceKey: managedNamespaceKey(actor.representativeId),
              ...data,
              revision: 1,
            },
          });
        }

        // The policy row is the synchronous recall fence. Only after that
        // update succeeds do we queue exact governed-memory projection
        // cleanup. PublicKnowledgeProjectionItem is intentionally outside
        // this path and short-term policy changes never select any projection.
        const cleanup = current
          ? await queueDisabledMemoryProjectionCleanup(
              tx,
              actor.representativeId,
              current,
              parsed.policy,
              updated.updatedAt,
            )
          : { deletePendingCount: 0, inFlightDeleteRequestedCount: 0 };
        const retention = current
          ? await capExistingActiveMemoryRetention(
              tx,
              actor.representativeId,
              current.retentionDays,
              parsed.policy.retention.days,
              updated.updatedAt,
            )
          : { cappedMemoryCount: 0, expiresNoLaterThan: null };

        await tx.eventAudit.create({
          data: {
            ownerId: actor.actorOwnerId,
            representativeId: actor.representativeId,
            idempotencyKey,
            requestHash,
            type: EventType.OPENVIKING_CONFIG_CHANGED,
            payload: {
              action: "representative_memory_policy_updated",
              requestId,
              actorRole: actor.role,
              changedFields: memoryPolicyChangedFields(current, updated),
              projectionCleanup: cleanup,
              retention,
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
          actor,
          configured: true,
          revision: updated.revision,
          updatedAt: updated.updatedAt.toISOString(),
          policy: parsed.policy,
          managed: {
            agentId: updated.managedAgentId,
            namespace: updated.namespaceKey,
            targetUri: updated.managedTargetUri,
          },
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      { additionalRetryableCodes: ["P2002"] },
    );

    const sync = await loadMemorySyncSnapshot(
      client,
      result.actor.representativeId,
      result.policy.advanced.provider,
      options.env ?? process.env,
      options.now?.() ?? new Date(),
    );
    return {
      replayed: result.replayed,
      requestId,
      settings: serializeMemorySettingsContract({ ...result, sync }),
    };
  } catch (error) {
    if (error instanceof MemorySettingsError) throw error;
    const code = prismaErrorCode(error);
    if (code === "P2002") throw versionConflict();
    if (code === "P2034") {
      throw new MemorySettingsError(
        "memory_dashboard_state_conflict",
        "The memory settings write conflicted with another request.",
        409,
      );
    }
    throw error;
  }
}

async function resolveMemorySettingsActor(
  client: MemorySettingsClient | Prisma.TransactionClient,
  actorOwnerId: string,
  representativeSlug: string,
): Promise<MemorySettingsActor> {
  const representative = await client.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      ownerId: true,
      owner: { select: { organizationId: true } },
    },
  });
  if (!representative) throw notFound();
  if (representative.ownerId === actorOwnerId) {
    return {
      actorOwnerId,
      representativeId: representative.id,
      representativeSlug: representative.slug,
      representativeName: representative.displayName,
      role: "OWNER",
    };
  }

  const actor = await client.owner.findUnique({
    where: { id: actorOwnerId },
    select: {
      organizationId: true,
      organizationMember: {
        select: { organizationId: true, role: true },
      },
    },
  });
  const organizationId = representative.owner.organizationId;
  const role = actor?.organizationMember?.role;
  if (
    !organizationId
    || actor?.organizationId !== organizationId
    || actor.organizationMember?.organizationId !== organizationId
    || (
      role !== OrganizationMemberRole.OWNER
      && role !== OrganizationMemberRole.ADMIN
      && role !== OrganizationMemberRole.APPROVER
    )
  ) {
    throw notFound();
  }
  return {
    actorOwnerId,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    representativeName: representative.displayName,
    role: role === OrganizationMemberRole.ADMIN
      ? "ADMIN"
      : role === OrganizationMemberRole.APPROVER
        ? "REVIEWER"
        : "OWNER",
  };
}

function assertMemorySettingsActor(actor: MemorySettingsActor) {
  if (actor.role === "REVIEWER") {
    throw new MemorySettingsError(
      "memory_dashboard_forbidden",
      "Reviewers cannot change representative memory policy.",
      403,
    );
  }
}

function withSystemManagedCrossChannelCapability(
  policy: z.infer<typeof memorySettingsPolicyShape>,
) {
  return {
    ...policy,
    basic: {
      ...policy.basic,
      contactMemoryCrossChannelEnabled:
        policy.basic.longTermMemoryEnabled
        && policy.basic.contactMemoryEnabled,
    },
  };
}

function policyUpdateData(policy: z.infer<typeof memorySettingsPolicyShape>) {
  return {
    longTermMemoryEnabled: policy.basic.longTermMemoryEnabled,
    shortTermMemoryEnabled: policy.basic.shortTermMemoryEnabled,
    contactMemoryEnabled: policy.basic.contactMemoryEnabled,
    contactMemoryCrossChannelEnabled:
      policy.basic.longTermMemoryEnabled && policy.basic.contactMemoryEnabled,
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

async function capExistingActiveMemoryRetention(
  tx: Prisma.TransactionClient,
  representativeId: string,
  currentDays: number,
  nextDays: number,
  policyUpdatedAt: Date,
) {
  if (nextDays >= currentDays) {
    return { cappedMemoryCount: 0, expiresNoLaterThan: null };
  }
  const delegate = (tx as unknown as {
    governedMemory?: { updateMany?: typeof tx.governedMemory.updateMany };
  }).governedMemory;
  if (typeof delegate?.updateMany !== "function") {
    return { cappedMemoryCount: 0, expiresNoLaterThan: null };
  }
  const expiresNoLaterThan = new Date(
    policyUpdatedAt.getTime() + nextDays * 86_400_000,
  );
  const capped = await delegate.updateMany({
    where: {
      representativeId,
      status: GovernedMemoryStatus.ACTIVE,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: expiresNoLaterThan } },
      ],
    },
    data: { expiresAt: expiresNoLaterThan },
  });
  return {
    cappedMemoryCount: capped.count,
    expiresNoLaterThan: expiresNoLaterThan.toISOString(),
  };
}

async function queueDisabledMemoryProjectionCleanup(
  tx: Prisma.TransactionClient,
  representativeId: string,
  current: {
    longTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
    contactMemoryCrossChannelEnabled: boolean;
    representativeExperienceEnabled: boolean;
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  },
  next: z.infer<typeof memorySettingsPolicyShape>,
  requestedAt: Date,
) {
  const disabledLongTerm = current.longTermMemoryEnabled
    && !next.basic.longTermMemoryEnabled;
  const disabledContact = current.contactMemoryEnabled
    && !next.basic.contactMemoryEnabled;
  const disabledCrossChannel = current.contactMemoryCrossChannelEnabled
    && !next.basic.contactMemoryCrossChannelEnabled;
  const disabledRepresentativeExperience = current.representativeExperienceEnabled
    && !next.basic.representativeExperienceEnabled;
  const disabledWebRecall = current.webRecallEnabled
    && !next.channels.web.recallEnabled;
  const disabledMatrixRecall = current.matrixRecallEnabled
    && !next.channels.matrix.recallEnabled;
  const disabledTelegramRecall = current.telegramRecallEnabled
    && !next.channels.telegram.recallEnabled;
  if (
    !disabledLongTerm
    && !disabledContact
    && !disabledCrossChannel
    && !disabledRepresentativeExperience
    && !disabledWebRecall
    && !disabledMatrixRecall
    && !disabledTelegramRecall
  ) {
    return { deletePendingCount: 0, inFlightDeleteRequestedCount: 0 };
  }

  const scopeFilters: Prisma.MemoryProjectionItemWhereInput[] = [];
  if (disabledContact) {
    scopeFilters.push({
      memoryVersion: {
        memory: {
          scope: {
            in: [MemoryScope.CONTACT_CHANNEL, MemoryScope.CONTACT_SHARED],
          },
        },
      },
    });
  }
  if (disabledCrossChannel) {
    scopeFilters.push({
      memoryVersion: {
        memory: { scope: MemoryScope.CONTACT_SHARED },
      },
    });
  }
  if (disabledRepresentativeExperience) {
    scopeFilters.push({
      memoryVersion: {
        memory: { scope: MemoryScope.REPRESENTATIVE },
      },
    });
  }
  const noRecallChannelEnabled = !next.channels.web.recallEnabled
    && !next.channels.matrix.recallEnabled
    && !next.channels.telegram.recallEnabled;
  if (noRecallChannelEnabled) {
    scopeFilters.push({ lane: MemoryProjectionLane.RECALL });
  } else {
    const disabledChannels = [
      disabledWebRecall ? "WEB" as const : null,
      disabledMatrixRecall ? "MATRIX" as const : null,
      disabledTelegramRecall ? "TELEGRAM" as const : null,
    ].filter((channel): channel is "WEB" | "MATRIX" | "TELEGRAM" => Boolean(channel));
    if (disabledChannels.length) {
      scopeFilters.push({
        memoryVersion: {
          memory: {
            scope: MemoryScope.CONTACT_CHANNEL,
            sourceChannel: { in: disabledChannels },
          },
        },
      });
    }
  }
  const target: Prisma.MemoryProjectionItemWhereInput = {
    representativeId,
    ...(!disabledLongTerm ? { OR: scopeFilters } : {}),
  };
  const reasonCode = "projection_cleanup_requested_by_memory_policy";
  const directlyQueued = await tx.memoryProjectionItem.updateMany({
    where: {
      ...target,
      status: {
        in: [
          MemoryProjectionStatus.QUEUED,
          MemoryProjectionStatus.STAGED,
          MemoryProjectionStatus.ACTIVE,
          MemoryProjectionStatus.RETRYING,
          MemoryProjectionStatus.SUPERSEDED,
          MemoryProjectionStatus.FAILED,
          MemoryProjectionStatus.DELETE_FAILED,
        ],
      },
    },
    data: {
      status: MemoryProjectionStatus.DELETE_PENDING,
      deleteRequestedAt: requestedAt,
      availableAt: requestedAt,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: reasonCode,
    },
  });
  const inFlight = await tx.memoryProjectionItem.updateMany({
    where: {
      ...target,
      status: MemoryProjectionStatus.PROJECTING,
    },
    data: {
      // Preserve the active lease. Both the success and failure completion
      // paths observe deleteRequestedAt and converge to DELETE_PENDING.
      deleteRequestedAt: requestedAt,
      lastErrorCode: reasonCode,
    },
  });
  return {
    deletePendingCount: directlyQueued.count,
    inFlightDeleteRequestedCount: inFlight.count,
  };
}

function serializeMemorySettings(input: {
  actor: MemorySettingsActor;
  policy: Awaited<ReturnType<MemorySettingsClient["representativeMemoryPolicy"]["findUnique"]>>;
  sync: MemorySyncSnapshot | null;
}) {
  const { actor, policy, sync } = input;
  return serializeMemorySettingsContract({
    actor,
    configured: Boolean(policy),
    revision: policy?.revision ?? 0,
    updatedAt: policy?.updatedAt.toISOString() ?? null,
    policy: {
      basic: {
        longTermMemoryEnabled: policy?.longTermMemoryEnabled ?? false,
        shortTermMemoryEnabled: policy?.shortTermMemoryEnabled ?? true,
        contactMemoryEnabled: policy?.contactMemoryEnabled ?? false,
        contactMemoryCrossChannelEnabled:
          policy?.contactMemoryCrossChannelEnabled ?? false,
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
    managed: {
      agentId: policy?.managedAgentId ?? null,
      namespace: policy?.namespaceKey ?? null,
      targetUri: policy?.managedTargetUri ?? null,
    },
    sync,
  });
}

function serializeMemorySettingsContract(input: {
  actor: MemorySettingsActor;
  configured: boolean;
  revision: number;
  updatedAt: string | null;
  policy: z.infer<typeof memorySettingsPolicyShape>;
  managed?: {
    agentId: string | null;
    namespace: string | null;
    targetUri: string | null;
  };
  sync: MemorySyncSnapshot | null;
}) {
  const { actor, policy } = input;
  const longTermMemoryEnabled = policy.basic.longTermMemoryEnabled;
  const shortTermMemoryEnabled = policy.basic.shortTermMemoryEnabled;
  const contactMemoryEnabled = longTermMemoryEnabled
    && policy.basic.contactMemoryEnabled;
  const contactMemoryCrossChannelEnabled = contactMemoryEnabled;
  const representativeExperienceEnabled = longTermMemoryEnabled
    && policy.basic.representativeExperienceEnabled;
  const autoExtract = longTermMemoryEnabled
    && (contactMemoryEnabled || representativeExperienceEnabled)
    && policy.basic.autoExtract;
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
      shortTermMemoryEnabled,
      contactMemoryEnabled,
      contactMemoryCrossChannelEnabled,
      contactMemoryCrossChannelSupported: true as const,
      representativeExperienceEnabled,
      autoExtract,
      automaticPolicyEnabled: true as const,
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
        recallSupported: true,
        extractSupported: true,
        recallEnabled: longTermMemoryEnabled
          && (contactMemoryEnabled || representativeExperienceEnabled)
          && policy.channels.matrix.recallEnabled,
        extractEnabled: autoExtract && policy.channels.matrix.extractEnabled,
      },
      telegram: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: longTermMemoryEnabled
          && (contactMemoryEnabled || representativeExperienceEnabled)
          && policy.channels.telegram.recallEnabled,
        extractEnabled: autoExtract && policy.channels.telegram.extractEnabled,
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
      namespaceManagedByServer: true as const,
      targetManagedByServer: true as const,
      managedAgentId: input.managed?.agentId ?? null,
      managedNamespace: input.managed?.namespace ?? null,
      managedTargetUri: input.managed?.targetUri ?? null,
      managedUserId: input.managed?.namespace
        ? buildGovernedMemoryManagedUserId(input.managed.namespace)
        : null,
      managedUriStrategy: "PER_MEMORY_VERSION" as const,
      sync: input.sync,
    },
    updatedAt: input.updatedAt,
    settingsHref: settingsHref(actor.representativeSlug),
  };
}

async function loadMemorySyncSnapshot(
  client: MemorySettingsClient,
  representativeId: string,
  provider: string,
  env: NodeJS.ProcessEnv,
  occurredAt: Date,
): Promise<MemorySyncSnapshot | null> {
  const candidate = client as unknown as Partial<SyncSnapshotClient>;
  if (
    !candidate.memoryProjectionItem
    || typeof candidate.memoryProjectionItem.groupBy !== "function"
    || typeof candidate.memoryProjectionItem.aggregate !== "function"
    || typeof candidate.memoryProjectionItem.findFirst !== "function"
    || !candidate.memoryReconciliationRun
    || typeof candidate.memoryReconciliationRun.findFirst !== "function"
  ) {
    // Unit-test and migration-time clients may intentionally expose only the
    // settings delegates. Returning null is honest; fabricated zeroes are not.
    return null;
  }
  const syncClient = candidate as SyncSnapshotClient;
  const [groups, projected, projectionError, reconciliation] = await Promise.all([
    syncClient.memoryProjectionItem.groupBy({
      by: ["status"],
      where: { representativeId, provider },
      _count: { _all: true },
    }),
    syncClient.memoryProjectionItem.aggregate({
      where: { representativeId, provider },
      _max: { projectedAt: true },
    }),
    syncClient.memoryProjectionItem.findFirst({
      where: {
        representativeId,
        provider,
        lastErrorCode: { not: null },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { lastErrorCode: true, updatedAt: true },
    }),
    syncClient.memoryReconciliationRun.findFirst({
      where: { representativeId, provider },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        status: true,
        finishedAt: true,
        errorCode: true,
        issueCount: true,
        updatedAt: true,
      },
    }),
  ]);
  const counts = new Map(groups.map((group) => [group.status, group._count._all]));
  const queuedCount = countStatuses(counts, [
    MemoryProjectionStatus.QUEUED,
    MemoryProjectionStatus.PROJECTING,
  ]);
  const activeCount = countStatuses(counts, [MemoryProjectionStatus.ACTIVE]);
  const retryingCount = countStatuses(counts, [MemoryProjectionStatus.RETRYING]);
  const failedCount = countStatuses(counts, [
    MemoryProjectionStatus.FAILED,
    MemoryProjectionStatus.DELETE_FAILED,
  ]);
  const deletePendingCount = countStatuses(counts, [
    MemoryProjectionStatus.DELETE_PENDING,
    MemoryProjectionStatus.DELETING,
  ]);
  const latestError = latestSyncError(projectionError, reconciliation);
  const connectionStatus = resolveProviderConnectionStatus(env);
  const operationalStatus = resolveProviderOperationalStatus({
    connectionStatus,
    reconciliation,
    activeCount,
    queuedCount,
    deletePendingCount,
    failedCount,
    retryingCount,
    occurredAt,
  });
  return {
    providerStatus: legacyProviderStatus(connectionStatus, operationalStatus),
    connectionStatus,
    operationalStatus,
    inventoryCoverage: "KNOWN_PROJECTIONS_ONLY",
    capabilityCode: "openviking_inventory_no_snapshot_cursor",
    queuedCount,
    activeCount,
    retryingCount,
    failedCount,
    deletePendingCount,
    lastProjectedAt: projected._max.projectedAt?.toISOString() ?? null,
    lastReconciledAt: reconciliation?.finishedAt?.toISOString() ?? null,
    lastErrorCode: latestError,
    reconciliationIntervalMinutes,
    retryStrategy: "capped_exponential_backoff_with_leases",
  };
}

function resolveProviderConnectionStatus(
  env: NodeJS.ProcessEnv,
): MemorySyncSnapshot["connectionStatus"] {
  try {
    return resolveOpenVikingEnv(env).enabled ? "CONFIGURED" : "DISABLED";
  } catch {
    return "MISCONFIGURED";
  }
}

function resolveProviderOperationalStatus(input: {
  connectionStatus: MemorySyncSnapshot["connectionStatus"];
  reconciliation: SyncReconciliationRun;
  activeCount: number;
  queuedCount: number;
  deletePendingCount: number;
  failedCount: number;
  retryingCount: number;
  occurredAt: Date;
}): MemorySyncSnapshot["operationalStatus"] {
  if (input.connectionStatus !== "CONFIGURED") return "DEGRADED";
  if (input.reconciliation?.status === MemoryReconciliationStatus.FAILED) {
    return "FAILED";
  }
  if (input.failedCount > 0 || input.retryingCount > 0) return "DEGRADED";
  if (
    input.reconciliation?.status === MemoryReconciliationStatus.PARTIAL
    && (
      input.reconciliation.issueCount > 0
      || (
        input.reconciliation.errorCode
        && input.reconciliation.errorCode
          !== "openviking_inventory_no_snapshot_cursor"
      )
    )
  ) return "DEGRADED";
  if (input.reconciliation?.status === MemoryReconciliationStatus.SUCCEEDED) {
    const finishedAt = input.reconciliation.finishedAt;
    const freshnessWindowMs = reconciliationIntervalMinutes
      * reconciliationFreshnessIntervals
      * 60_000;
    const fresh = Boolean(
      finishedAt
      && Number.isFinite(input.occurredAt.getTime())
      && input.occurredAt.getTime() - finishedAt.getTime()
        <= freshnessWindowMs,
    );
    if (fresh) return "HEALTHY";
    if (
      input.activeCount > 0
      || input.queuedCount > 0
      || input.deletePendingCount > 0
    ) return "DEGRADED";
    return "IDLE";
  }
  if (input.activeCount > 0) return "AVAILABLE";
  return "IDLE";
}

function legacyProviderStatus(
  connectionStatus: MemorySyncSnapshot["connectionStatus"],
  operationalStatus: MemorySyncSnapshot["operationalStatus"],
): MemorySyncSnapshot["providerStatus"] {
  if (connectionStatus === "DISABLED") return "DISABLED";
  if (connectionStatus === "MISCONFIGURED") return "DEGRADED";
  if (operationalStatus === "IDLE") return null;
  return operationalStatus;
}

function latestSyncError(
  projection: SyncProjectionError,
  reconciliation: SyncReconciliationRun,
) {
  const candidates = [
    projection?.lastErrorCode
      ? { code: projection.lastErrorCode, updatedAt: projection.updatedAt }
      : null,
    reconciliation?.errorCode
      && reconciliation.errorCode
        !== "openviking_inventory_no_snapshot_cursor"
      ? { code: reconciliation.errorCode, updatedAt: reconciliation.updatedAt }
      : null,
  ].filter((item): item is { code: string; updatedAt: Date } => item !== null);
  candidates.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return candidates[0]?.code ?? null;
}

function countStatuses(
  counts: Map<MemoryProjectionStatus, number>,
  statuses: MemoryProjectionStatus[],
) {
  return statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
}

function readStoredMemorySettingsResult(payload: Prisma.JsonValue) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  return storedMemorySettingsResultSchema.safeParse(payload.result).data ?? null;
}

function legacyCompatibleUpdate(
  update: z.infer<typeof representativeMemorySettingsUpdateSchema>,
) {
  const {
    shortTermMemoryEnabled: _shortTermMemoryEnabled,
    contactMemoryCrossChannelEnabled: _contactMemoryCrossChannelEnabled,
    ...legacyBasic
  } = update.policy.basic;
  return {
    expectedRevision: update.expectedRevision,
    policy: {
      ...update.policy,
      basic: legacyBasic,
    },
  };
}

function memoryPolicyChangedFields(
  current: Awaited<ReturnType<MemorySettingsClient["representativeMemoryPolicy"]["findUnique"]>>,
  updated: NonNullable<Awaited<ReturnType<MemorySettingsClient["representativeMemoryPolicy"]["findUnique"]>>>,
) {
  const fields = [
    "longTermMemoryEnabled",
    "shortTermMemoryEnabled",
    "contactMemoryEnabled",
    "contactMemoryCrossChannelEnabled",
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

function managedNamespaceKey(representativeId: string) {
  return `mem_${createHash("sha256")
    .update(`delegate-memory:${representativeId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function settingsHref(representativeSlug: string) {
  return `/dashboard?${new URLSearchParams({
    view: "representatives",
    rep: representativeSlug,
    repSection: "setup",
    setupSection: "memory",
  }).toString()}`;
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function versionConflict() {
  return new MemorySettingsError(
    "memory_dashboard_version_conflict",
    "Memory settings changed. Reload before saving again.",
    409,
  );
}

function notFound() {
  return new MemorySettingsError(
    "memory_dashboard_not_found",
    "Memory settings not found.",
    404,
  );
}

function prismaErrorCode(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}
